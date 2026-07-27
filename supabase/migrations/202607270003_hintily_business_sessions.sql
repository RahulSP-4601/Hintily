begin;

-- Business decisions encoded here:
-- * Trials are account-bound, non-expiring, and can span multiple sessions.
-- * Paid packs are separate 3,600-second allocations; unused time survives.
-- * At most one metered business session may be active per account.
-- * Reservations expire after five minutes; reconnects use the same client id.
-- * Only server-confirmed active STT time is charged, in idempotent heartbeats.

create unique index if not exists hintily_one_trial_per_user
  on public.entitlements(user_id)
  where source = 'free_trial';

create unique index if not exists hintily_one_open_metered_session_per_user
  on public.business_sessions(user_id)
  where status in ('pending', 'active', 'paused');

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

  select jsonb_build_object(
    'user_id', caller,
    'unlimited', exists(
      select 1 from public.entitlements e
      where e.user_id = caller and e.unlimited
        and e.status in ('trial', 'active')
        and e.starts_at <= now() and (e.ends_at is null or e.ends_at > now())
    ),
    'remaining_seconds', coalesce((
      select sum(greatest(a.allocated_seconds - a.consumed_seconds, 0))
      from public.session_allocations a
      where a.user_id = caller and a.status in ('available', 'reserved', 'active')
        and (a.expires_at is null or a.expires_at > now())
    ), 0),
    'trial_remaining_seconds', coalesce((
      select sum(greatest(a.allocated_seconds - a.consumed_seconds, 0))
      from public.session_allocations a
      where a.user_id = caller and a.kind = 'trial'
        and a.status in ('available', 'reserved', 'active')
        and (a.expires_at is null or a.expires_at > now())
    ), 0),
    'paid_session_count', (
      select count(*) from public.session_allocations a
      where a.user_id = caller and a.kind = 'paid'
        and a.status in ('available', 'reserved', 'active')
        and a.consumed_seconds < a.allocated_seconds
        and (a.expires_at is null or a.expires_at > now())
    ),
    'access_revision', (
      select max(revision)
      from (
        select max(p.updated_at) as revision from public.purchases p where p.user_id = caller
        union all
        select max(e.updated_at) as revision from public.entitlements e where e.user_id = caller
      ) revisions
    ),
    'active_session', (
      select jsonb_build_object(
        'id', s.id, 'client_session_id', s.client_session_id,
        'status', s.status, 'consumed_seconds', s.consumed_seconds,
        'last_heartbeat_at', s.last_heartbeat_at
      )
      from public.business_sessions s
      where s.user_id = caller and s.status in ('pending', 'active', 'paused')
      order by s.created_at desc limit 1
    )
  ) into result;
  return result;
end;
$$;

create or replace function public.hintily_ensure_trial()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  entitlement uuid;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;

  insert into public.entitlements(
    user_id, plan_code, plan_name, status, unlimited, source, source_reference
  ) values (
    caller, 'free_trial', '20 Minute Free Trial', 'trial', false,
    'free_trial', caller::text
  )
  on conflict (source, source_reference) where source_reference is not null
  do update set updated_at = public.entitlements.updated_at
  returning id into entitlement;

  insert into public.session_allocations(
    user_id, entitlement_id, kind, status, allocated_seconds, consumed_seconds
  )
  select caller, entitlement, 'trial', 'available', 1200, 0
  where not exists (
    select 1 from public.session_allocations
    where user_id = caller and kind = 'trial'
  );

  return public.hintily_account_state();
end;
$$;

create or replace function public.hintily_authorize_session(requested_client_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  existing public.business_sessions%rowtype;
  allocation public.session_allocations%rowtype;
  session_id uuid;
  unlimited_access boolean;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  if requested_client_session_id is null then raise exception 'invalid_client_session_id'; end if;

  select * into existing from public.business_sessions
  where user_id = caller and client_session_id = requested_client_session_id
  limit 1;
  if found then
    return jsonb_build_object('session_id', existing.id, 'status', existing.status,
      'reconnected', true, 'remaining_seconds',
      greatest(coalesce((select allocated_seconds - consumed_seconds
        from public.session_allocations where id = existing.allocation_id), 0), 0),
      'unlimited', existing.allocation_id is null,
      'next_sequence_no', coalesce((
        select max(u.sequence_no) + 1
        from public.usage_sessions u
        where u.business_session_id = existing.id
      ), 0));
  end if;

  update public.business_sessions s
  set status = 'abandoned', completed_at = now(), updated_at = now()
  where s.user_id = caller and s.status = 'pending'
    and s.created_at < now() - interval '5 minutes';
  update public.session_allocations a
  set status = 'available', reserved_at = null, updated_at = now()
  where a.user_id = caller and a.status = 'reserved'
    and a.reserved_at < now() - interval '5 minutes'
    and not exists (
      select 1 from public.business_sessions s
      where s.allocation_id = a.id and s.status in ('pending', 'active', 'paused')
    );

  select exists(
    select 1 from public.entitlements e
    where e.user_id = caller and e.unlimited and e.status in ('trial', 'active')
      and e.starts_at <= now() and (e.ends_at is null or e.ends_at > now())
  ) into unlimited_access;

  if not unlimited_access then
    select * into allocation
    from public.session_allocations a
    where a.user_id = caller and a.status = 'available'
      and a.consumed_seconds < a.allocated_seconds
      and (a.expires_at is null or a.expires_at > now())
    order by case when a.kind = 'trial' then 0 else 1 end, a.created_at
    for update skip locked limit 1;
    if not found then raise exception 'no_time_remaining' using errcode = 'P0001'; end if;
    update public.session_allocations
    set status = 'reserved', reserved_at = now(), updated_at = now()
    where id = allocation.id;
  end if;

  insert into public.business_sessions(
    user_id, allocation_id, status, client_session_id
  ) values (
    caller, case when unlimited_access then null else allocation.id end,
    'pending', requested_client_session_id
  ) returning id into session_id;

  return jsonb_build_object('session_id', session_id, 'status', 'pending',
    'reconnected', false, 'unlimited', unlimited_access,
    'next_sequence_no', 0,
    'remaining_seconds', case when unlimited_access then null
      else allocation.allocated_seconds - allocation.consumed_seconds end);
exception
  when unique_violation then
    raise exception 'session_already_active' using errcode = 'P0001';
end;
$$;

create or replace function public.hintily_activate_session(requested_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target public.business_sessions%rowtype;
  unlimited_access boolean;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into target from public.business_sessions
  where id = requested_session_id and user_id = caller for update;
  if not found then raise exception 'session_not_found'; end if;
  if target.status not in ('pending', 'paused', 'active') then raise exception 'session_not_activatable'; end if;

  if target.allocation_id is not null then
    update public.session_allocations set status = 'active',
      activated_at = coalesce(activated_at, now()), updated_at = now()
    where id = target.allocation_id and status in ('reserved', 'active');
    if not found then raise exception 'session_not_activatable'; end if;
  else
    select exists(
      select 1 from public.entitlements e
      where e.user_id = caller and e.unlimited
        and e.status in ('trial', 'active')
        and e.starts_at <= now() and (e.ends_at is null or e.ends_at > now())
    ) into unlimited_access;
    if not unlimited_access then raise exception 'session_not_activatable'; end if;
  end if;

  update public.business_sessions set status = 'active',
    started_at = coalesce(started_at, now()), last_heartbeat_at = now(), updated_at = now()
  where id = target.id;
  return jsonb_build_object('session_id', target.id, 'status', 'active');
end;
$$;

create or replace function public.hintily_session_heartbeat(
  requested_session_id uuid, requested_sequence_no integer, requested_active_seconds integer
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
  charge integer := 0;
  inserted integer := 0;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  if requested_sequence_no < 0 or requested_active_seconds < 0 or requested_active_seconds > 300
    then raise exception 'invalid_heartbeat'; end if;

  select * into target from public.business_sessions
  where id = requested_session_id and user_id = caller for update;
  if not found or target.status <> 'active' then raise exception 'session_not_active'; end if;

  if target.allocation_id is not null then
    select * into allocation from public.session_allocations
    where id = target.allocation_id for update;
    charge := least(requested_active_seconds,
      greatest(allocation.allocated_seconds - allocation.consumed_seconds, 0));
  else
    charge := requested_active_seconds;
  end if;

  insert into public.usage_sessions(
    user_id, business_session_id, sequence_no, active_seconds, observed_at
  ) values (caller, target.id, requested_sequence_no, charge, now())
  on conflict (business_session_id, sequence_no) do nothing;
  get diagnostics inserted = row_count;

  if inserted = 1 then
    update public.business_sessions set consumed_seconds = consumed_seconds + charge,
      last_heartbeat_at = now(), updated_at = now() where id = target.id;
    if target.allocation_id is not null then
      update public.session_allocations set consumed_seconds = consumed_seconds + charge,
        status = case when consumed_seconds + charge >= allocated_seconds then 'consumed' else 'active' end,
        updated_at = now() where id = target.allocation_id;
    end if;
  end if;

  return jsonb_build_object('accepted_seconds', case when inserted = 1 then charge else 0 end,
    'duplicate', inserted = 0, 'remaining_seconds',
    case when target.allocation_id is null then null else
      greatest(allocation.allocated_seconds - allocation.consumed_seconds -
        case when inserted = 1 then charge else 0 end, 0) end,
    'exhausted', target.allocation_id is not null and
      allocation.consumed_seconds + case when inserted = 1 then charge else 0 end >= allocation.allocated_seconds);
end;
$$;

-- Relay-only metering derives chargeable time from the database clock rather
-- than a client-supplied duration. Concurrent audio channels serialize on the
-- business-session row, so two channels still consume one wall-clock session.
create or replace function public.hintily_proxy_heartbeat(requested_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target public.business_sessions%rowtype;
  allocation public.session_allocations%rowtype;
  elapsed integer;
  charge integer;
  next_sequence integer;
  remaining integer;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into target from public.business_sessions
  where id = requested_session_id and user_id = caller for update;
  if not found or target.status <> 'active' then raise exception 'session_not_active'; end if;

  elapsed := least(30, greatest(0, floor(extract(epoch from
    (now() - coalesce(target.last_heartbeat_at, now()))))::integer));
  if target.allocation_id is not null then
    select * into allocation from public.session_allocations
    where id = target.allocation_id and status = 'active' for update;
    if not found then raise exception 'session_not_active'; end if;
    charge := least(elapsed,
      greatest(allocation.allocated_seconds - allocation.consumed_seconds, 0));
    remaining := greatest(allocation.allocated_seconds - allocation.consumed_seconds - charge, 0);
  else
    charge := elapsed;
    remaining := null;
  end if;

  if elapsed > 0 then
    select coalesce(max(sequence_no) + 1, 0) into next_sequence
    from public.usage_sessions where business_session_id = target.id;
    insert into public.usage_sessions(
      user_id, business_session_id, sequence_no, active_seconds, observed_at
    ) values (caller, target.id, next_sequence, charge, now());
    update public.business_sessions set consumed_seconds = consumed_seconds + charge,
      last_heartbeat_at = now(), updated_at = now() where id = target.id;
    if target.allocation_id is not null then
      update public.session_allocations set consumed_seconds = consumed_seconds + charge,
        status = case when consumed_seconds + charge >= allocated_seconds then 'consumed' else 'active' end,
        updated_at = now() where id = target.allocation_id;
    end if;
  end if;

  return jsonb_build_object(
    'accepted_seconds', charge,
    'remaining_seconds', remaining,
    'exhausted', target.allocation_id is not null and remaining = 0
  );
end;
$$;

create or replace function public.hintily_complete_session(requested_session_id uuid, requested_failure_code text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target public.business_sessions%rowtype;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into target from public.business_sessions
  where id = requested_session_id and user_id = caller for update;
  if not found then raise exception 'session_not_found'; end if;

  update public.business_sessions set
    status = case when requested_failure_code is null then 'completed' else 'failed' end,
    failure_code = left(requested_failure_code, 80), completed_at = now(), updated_at = now()
  where id = target.id and status in ('pending', 'active', 'paused');

  if target.allocation_id is not null then
    update public.session_allocations set
      status = case
        when consumed_seconds >= allocated_seconds then 'consumed'
        else 'available'
      end,
      reserved_at = null, updated_at = now()
    where id = target.allocation_id and status in ('reserved', 'active');
  end if;
  return public.hintily_account_state();
end;
$$;

revoke all on function public.hintily_account_state() from public, anon;
revoke all on function public.hintily_ensure_trial() from public, anon;
revoke all on function public.hintily_authorize_session(uuid) from public, anon;
revoke all on function public.hintily_activate_session(uuid) from public, anon;
revoke all on function public.hintily_session_heartbeat(uuid, integer, integer) from public, anon;
revoke all on function public.hintily_proxy_heartbeat(uuid) from public, anon;
revoke all on function public.hintily_complete_session(uuid, text) from public, anon;
grant execute on function public.hintily_account_state() to authenticated;
grant execute on function public.hintily_ensure_trial() to authenticated;
grant execute on function public.hintily_authorize_session(uuid) to authenticated;
grant execute on function public.hintily_activate_session(uuid) to authenticated;
grant execute on function public.hintily_session_heartbeat(uuid, integer, integer) to authenticated;
grant execute on function public.hintily_proxy_heartbeat(uuid) to authenticated;
grant execute on function public.hintily_complete_session(uuid, text) to authenticated;

commit;
