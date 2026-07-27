begin;

create table if not exists public.deepgram_stream_leases (
  business_session_id uuid not null references public.business_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  channel text not null check (channel in ('interviewer', 'user')),
  lease_owner_id uuid not null,
  lease_id uuid not null,
  started_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (business_session_id, channel)
);

alter table public.deepgram_stream_leases enable row level security;
revoke all on public.deepgram_stream_leases from public, anon, authenticated;

create or replace function public.hintily_acquire_stream_lease(
  requested_session_id uuid,
  requested_channel text,
  requested_lease_owner_id uuid,
  requested_lease_id uuid
)
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
  if requested_channel not in ('interviewer', 'user')
    or requested_lease_owner_id is null or requested_lease_id is null then
    raise exception 'invalid_stream_lease';
  end if;

  select * into target
  from public.business_sessions
  where id = requested_session_id and user_id = caller
  for update;
  if not found or target.status <> 'active' then raise exception 'session_not_active'; end if;

  insert into public.deepgram_stream_leases(
    business_session_id, user_id, channel, lease_owner_id, lease_id, expires_at
  ) values (
    target.id, caller, requested_channel, requested_lease_owner_id,
    requested_lease_id, now() + interval '30 seconds'
  )
  on conflict (business_session_id, channel) do update
    set lease_id = excluded.lease_id,
        lease_owner_id = excluded.lease_owner_id,
        started_at = null,
        user_id = excluded.user_id,
        expires_at = excluded.expires_at,
        updated_at = now()
    where public.deepgram_stream_leases.expires_at <= now()
       or (
         public.deepgram_stream_leases.lease_owner_id = excluded.lease_owner_id
         and public.deepgram_stream_leases.updated_at <= now() - interval '25 seconds'
       )
       or public.deepgram_stream_leases.lease_id = excluded.lease_id;

  if not exists (
    select 1 from public.deepgram_stream_leases
    where business_session_id = target.id
      and channel = requested_channel
      and lease_id = requested_lease_id
  ) then
    raise exception 'stream_channel_in_use' using errcode = 'P0001';
  end if;

  return jsonb_build_object('acquired', true, 'lease_id', requested_lease_id);
end;
$$;

create or replace function public.hintily_renew_stream_lease(
  requested_session_id uuid,
  requested_channel text,
  requested_lease_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  update public.deepgram_stream_leases
  set expires_at = now() + interval '30 seconds', updated_at = now()
  where business_session_id = requested_session_id
    and user_id = caller and channel = requested_channel
    and lease_id = requested_lease_id and expires_at > now();
  if not found then raise exception 'stream_lease_expired'; end if;
end;
$$;

create or replace function public.hintily_mark_stream_ready(
  requested_session_id uuid,
  requested_channel text,
  requested_lease_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  already_metering boolean;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select exists (
    select 1 from public.deepgram_stream_leases
    where business_session_id = requested_session_id
      and user_id = caller and started_at is not null
      and expires_at > now()
      and not (channel = requested_channel and lease_id = requested_lease_id)
  ) into already_metering;

  update public.deepgram_stream_leases
  set started_at = coalesce(started_at, now()),
      expires_at = now() + interval '30 seconds', updated_at = now()
  where business_session_id = requested_session_id
    and user_id = caller and channel = requested_channel
    and lease_id = requested_lease_id and expires_at > now();
  if not found then raise exception 'stream_lease_expired'; end if;

  if not already_metering then
    update public.business_sessions
    set last_heartbeat_at = now(), updated_at = now()
    where id = requested_session_id and user_id = caller and status = 'active';
    if not found then raise exception 'session_not_active'; end if;
  end if;
end;
$$;

create or replace function public.hintily_release_stream_lease(
  requested_session_id uuid,
  requested_channel text,
  requested_lease_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then return; end if;
  delete from public.deepgram_stream_leases
  where business_session_id = requested_session_id
    and user_id = caller
    and channel = requested_channel
    and lease_id = requested_lease_id;
end;
$$;

create or replace function public.hintily_proxy_heartbeat(
  requested_session_id uuid,
  requested_channel text,
  requested_lease_id uuid
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
  elapsed integer;
  charge integer;
  next_sequence integer;
  remaining integer;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into target from public.business_sessions
  where id = requested_session_id and user_id = caller for update;
  if not found or target.status <> 'active' then raise exception 'session_not_active'; end if;

  update public.deepgram_stream_leases
  set expires_at = now() + interval '30 seconds', updated_at = now()
  where business_session_id = target.id
    and user_id = caller
    and channel = requested_channel
    and lease_id = requested_lease_id
    and started_at is not null
    and expires_at > now();
  if not found then raise exception 'stream_lease_expired'; end if;

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
    if not exists (
      select 1 from public.entitlements e
      where e.user_id = caller and e.unlimited
        and e.status in ('trial', 'active')
        and e.starts_at <= now() and (e.ends_at is null or e.ends_at > now())
    ) then
      update public.business_sessions
      set status = 'failed', failure_code = 'payment_access_revoked',
        completed_at = coalesce(completed_at, now()), updated_at = now()
      where id = target.id;
      delete from public.deepgram_stream_leases
      where business_session_id = target.id;
      return jsonb_build_object(
        'accepted_seconds', 0,
        'remaining_seconds', 0,
        'exhausted', true,
        'revoked', true
      );
    end if;
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
      if remaining = 0 then
        update public.business_sessions
        set status = 'completed', completed_at = coalesce(completed_at, now()),
          updated_at = now()
        where id = target.id;
        delete from public.deepgram_stream_leases
        where business_session_id = target.id;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'accepted_seconds', charge,
    'remaining_seconds', remaining,
    'exhausted', target.allocation_id is not null and remaining = 0
  );
end;
$$;

revoke all on function public.hintily_proxy_heartbeat(uuid) from public, anon, authenticated;
revoke all on function public.hintily_acquire_stream_lease(uuid, text, uuid, uuid) from public, anon;
revoke all on function public.hintily_renew_stream_lease(uuid, text, uuid) from public, anon;
revoke all on function public.hintily_mark_stream_ready(uuid, text, uuid) from public, anon;
revoke all on function public.hintily_release_stream_lease(uuid, text, uuid) from public, anon;
revoke all on function public.hintily_proxy_heartbeat(uuid, text, uuid) from public, anon;
grant execute on function public.hintily_acquire_stream_lease(uuid, text, uuid, uuid) to authenticated;
grant execute on function public.hintily_renew_stream_lease(uuid, text, uuid) to authenticated;
grant execute on function public.hintily_mark_stream_ready(uuid, text, uuid) to authenticated;
grant execute on function public.hintily_release_stream_lease(uuid, text, uuid) to authenticated;
grant execute on function public.hintily_proxy_heartbeat(uuid, text, uuid) to authenticated;

commit;
