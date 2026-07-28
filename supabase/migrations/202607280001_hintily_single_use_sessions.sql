begin;

-- Hintily session allocations are single-use:
-- * the free grant is one 1,200-second session;
-- * every paid allocation is one 3,600-second session;
-- * an allocation is restored only when it never became active;
-- * once active, stopping early consumes it and records the unused duration.

alter table public.session_allocations
  add column if not exists session_type text,
  add column if not exists maximum_seconds integer,
  add column if not exists consumed_at timestamptz,
  add column if not exists forfeited_seconds integer not null default 0,
  add column if not exists reservation_expires_at timestamptz;

alter table public.business_sessions
  add column if not exists surface text not null default 'interview_helper',
  add column if not exists activation_completed_at timestamptz,
  add column if not exists completion_reason text;

update public.session_allocations
set session_type = case when kind = 'trial' then 'free' else 'paid' end,
    maximum_seconds = allocated_seconds,
    reservation_expires_at = case
      when status = 'reserved' then coalesce(reserved_at, updated_at) + interval '5 minutes'
      else reservation_expires_at
    end
where session_type is null or maximum_seconds is null;

alter table public.session_allocations
  alter column session_type set not null,
  alter column session_type set default 'paid',
  alter column maximum_seconds set not null,
  alter column maximum_seconds set default 3600;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'session_allocations_session_type_check'
      and conrelid = 'public.session_allocations'::regclass
  ) then
    alter table public.session_allocations
      add constraint session_allocations_session_type_check
      check (session_type in ('free', 'paid'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'session_allocations_single_use_duration_check'
      and conrelid = 'public.session_allocations'::regclass
  ) then
    alter table public.session_allocations
      add constraint session_allocations_single_use_duration_check
      check (
        (session_type = 'free' and maximum_seconds = 1200)
        or (session_type = 'paid' and maximum_seconds = 3600)
      ) not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'business_sessions_surface_check'
      and conrelid = 'public.business_sessions'::regclass
  ) then
    alter table public.business_sessions
      add constraint business_sessions_surface_check
      check (surface in ('interview_helper', 'meeting'));
  end if;
end;
$$;

create index if not exists hintily_available_single_use_allocations
  on public.session_allocations(user_id, session_type, created_at)
  where status = 'available';

create or replace function public.hintily_single_use_allocation_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'reserved' and old.status is distinct from 'reserved' then
    new.reservation_expires_at := coalesce(new.reserved_at, now()) + interval '5 minutes';
  elsif new.status <> 'reserved' then
    new.reservation_expires_at := null;
  end if;
  if new.status = 'consumed' and old.status is distinct from 'consumed' then
    new.consumed_at := coalesce(new.consumed_at, now());
    new.forfeited_seconds := greatest(new.maximum_seconds - new.consumed_seconds, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists hintily_single_use_allocation_transition
  on public.session_allocations;
create trigger hintily_single_use_allocation_transition
before update on public.session_allocations
for each row execute function public.hintily_single_use_allocation_transition();

create or replace function public.hintily_complete_session(
  requested_session_id uuid,
  requested_failure_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target public.business_sessions%rowtype;
  allocation public.session_allocations%rowtype;
  was_activated boolean;
  reason text := nullif(left(coalesce(requested_failure_code, ''), 80), '');
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;

  select * into target
  from public.business_sessions
  where id = requested_session_id and user_id = caller
  for update;
  if not found then raise exception 'session_not_found'; end if;

  -- Completion is idempotent. A retry must never alter a previously settled
  -- allocation or convert a completed session into a failure.
  if target.status not in ('pending', 'active', 'paused') then
    return public.hintily_account_state();
  end if;

  was_activated := target.status in ('active', 'paused') or target.started_at is not null;

  update public.business_sessions
  set status = case
        when reason is null then 'completed'
        when was_activated then 'completed'
        else 'failed'
      end,
      failure_code = case when was_activated then null else reason end,
      completion_reason = coalesce(reason, 'user_completed'),
      completed_at = now(),
      updated_at = now()
  where id = target.id;

  if target.allocation_id is not null then
    select * into allocation
    from public.session_allocations
    where id = target.allocation_id
    for update;

    if was_activated then
      update public.session_allocations
      set status = 'consumed',
          consumed_at = coalesce(consumed_at, now()),
          forfeited_seconds = greatest(maximum_seconds - consumed_seconds, 0),
          reserved_at = null,
          reservation_expires_at = null,
          updated_at = now()
      where id = allocation.id and status in ('reserved', 'active');
    else
      update public.session_allocations
      set status = 'available',
          reserved_at = null,
          reservation_expires_at = null,
          updated_at = now()
      where id = allocation.id and status = 'reserved';
    end if;
  end if;

  return public.hintily_account_state();
end;
$$;

create or replace function public.hintily_account_state()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  result jsonb;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;

  -- A reservation is only a short startup lease. If the application crashes
  -- before activation, the next account refresh safely returns that exact
  -- allocation to the user instead of consuming it or reserving another one.
  update public.business_sessions s
  set status = 'failed',
      failure_code = 'reservation_expired',
      completion_reason = 'reservation_expired',
      completed_at = now(),
      updated_at = now()
  from public.session_allocations a
  where s.user_id = caller
    and s.allocation_id = a.id
    and s.status = 'pending'
    and a.status = 'reserved'
    and a.reservation_expires_at <= now();

  update public.session_allocations
  set status = 'available',
      reserved_at = null,
      reservation_expires_at = null,
      updated_at = now()
  where user_id = caller
    and status = 'reserved'
    and reservation_expires_at <= now();

  select jsonb_build_object(
    'user_id', caller,
    'unlimited', exists(
      select 1 from public.entitlements e
      where e.user_id = caller and e.unlimited
        and e.status in ('trial', 'active')
        and e.starts_at <= now() and (e.ends_at is null or e.ends_at > now())
    ),
    -- Kept for compatibility: this is the current active allocation's time,
    -- never a pooled/carry-forward balance.
    'remaining_seconds', coalesce((
      select case
        when a.status = 'active' then greatest(a.maximum_seconds - a.consumed_seconds, 0)
        else a.maximum_seconds
      end
      from public.session_allocations a
      where a.user_id = caller and a.status in ('active', 'available', 'reserved')
        and (a.expires_at is null or a.expires_at > now())
      order by case when a.status = 'active' then 0
                    when a.session_type = 'free' then 1 else 2 end,
               a.created_at
      limit 1
    ), 0),
    'trial_remaining_seconds', coalesce((
      select case
        when a.status = 'active' then greatest(a.maximum_seconds - a.consumed_seconds, 0)
        else a.maximum_seconds
      end
      from public.session_allocations a
      where a.user_id = caller and a.session_type = 'free'
        and a.status in ('available', 'reserved', 'active')
      order by a.created_at limit 1
    ), 0),
    'free_session_available', exists(
      select 1 from public.session_allocations a
      where a.user_id = caller and a.session_type = 'free'
        and a.status in ('available', 'reserved', 'active')
    ),
    'paid_session_count', (
      select count(*) from public.session_allocations a
      where a.user_id = caller and a.session_type = 'paid'
        and a.status in ('available', 'reserved', 'active')
        and (a.expires_at is null or a.expires_at > now())
    ),
    'access_revision', (
      select max(revision) from (
        select max(p.updated_at) revision from public.purchases p where p.user_id = caller
        union all
        select max(e.updated_at) revision from public.entitlements e where e.user_id = caller
        union all
        select max(a.updated_at) revision from public.session_allocations a where a.user_id = caller
      ) revisions
    ),
    'active_session', (
      select jsonb_build_object(
        'id', s.id,
        'client_session_id', s.client_session_id,
        'status', s.status,
        'surface', s.surface,
        'consumed_seconds', s.consumed_seconds,
        'maximum_seconds', a.maximum_seconds,
        'last_heartbeat_at', s.last_heartbeat_at
      )
      from public.business_sessions s
      left join public.session_allocations a on a.id = s.allocation_id
      where s.user_id = caller and s.status in ('pending', 'active', 'paused')
      order by s.created_at desc limit 1
    )
  ) into result;
  return result;
end;
$$;

-- Ensure future free grants carry the single-use fields even on databases
-- where those columns have no defaults.
create or replace function public.hintily_ensure_trial()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  entitlement uuid;
  is_google_identity boolean := false;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;

  select
    coalesce(u.raw_app_meta_data ->> 'provider' = 'google', false)
    or coalesce((u.raw_app_meta_data -> 'providers') ? 'google', false)
  into is_google_identity
  from auth.users u
  where u.id = caller
    and u.email_confirmed_at is not null;

  if not coalesce(is_google_identity, false) then
    raise exception 'verified_google_identity_required' using errcode = '42501';
  end if;

  insert into public.entitlements(
    user_id, plan_code, plan_name, status, unlimited, source, source_reference
  ) values (
    caller, 'free_trial', 'One 20-Minute Session', 'trial', false,
    'free_trial', caller::text
  )
  on conflict (source, source_reference) where source_reference is not null
  do update set updated_at = public.entitlements.updated_at
  returning id into entitlement;

  insert into public.session_allocations(
    user_id, entitlement_id, kind, session_type, status,
    allocated_seconds, maximum_seconds, consumed_seconds
  )
  select caller, entitlement, 'trial', 'free', 'available', 1200, 1200, 0
  where not exists (
    select 1 from public.session_allocations
    where user_id = caller and (kind = 'trial' or session_type = 'free')
  );

  return public.hintily_account_state();
end;
$$;

revoke all on function public.hintily_complete_session(uuid, text) from public, anon;
revoke all on function public.hintily_account_state() from public, anon;
revoke all on function public.hintily_ensure_trial() from public, anon;
grant execute on function public.hintily_complete_session(uuid, text) to authenticated;
grant execute on function public.hintily_account_state() to authenticated;
grant execute on function public.hintily_ensure_trial() to authenticated;

commit;
