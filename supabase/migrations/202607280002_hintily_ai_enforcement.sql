begin;

-- Readiness is checked before a single-use session is activated. Cache a
-- successful provider check and use a short claim to prevent concurrent or
-- replayed preflights from multiplying managed-provider requests.
alter table public.business_sessions
  add column if not exists ai_ready_at timestamptz,
  add column if not exists ai_readiness_claimed_at timestamptz,
  add column if not exists ai_readiness_claim_id uuid;

-- In-flight requests are represented by expiring leases instead of a counter.
-- If an edge-function invocation is terminated before cleanup, its slot
-- recovers automatically.
create table if not exists public.hintily_ai_request_leases (
  request_id uuid primary key,
  business_session_id uuid not null
    references public.business_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists hintily_ai_request_leases_active
  on public.hintily_ai_request_leases(business_session_id, expires_at);

create table if not exists public.hintily_ai_rate_windows (
  business_session_id uuid primary key
    references public.business_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now()
);

alter table public.hintily_ai_request_leases enable row level security;
alter table public.hintily_ai_rate_windows enable row level security;
revoke all on public.hintily_ai_request_leases from public, anon, authenticated;
revoke all on public.hintily_ai_rate_windows from public, anon, authenticated;

create or replace function public.hintily_ai_claim_readiness(
  requested_session_id uuid,
  requested_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.business_sessions%rowtype;
  claim_id uuid;
begin
  if requested_session_id is null or requested_user_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  select * into target
  from public.business_sessions
  where id = requested_session_id and user_id = requested_user_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if target.status not in ('pending', 'active') then
    return jsonb_build_object('ok', false, 'error', 'session_not_ready');
  end if;
  if target.ai_ready_at is not null then
    return jsonb_build_object('ok', true, 'state', 'cached');
  end if;
  if target.ai_readiness_claimed_at is not null
     and target.ai_readiness_claimed_at > now() - interval '30 seconds' then
    return jsonb_build_object('ok', false, 'error', 'readiness_in_progress');
  end if;

  claim_id := gen_random_uuid();
  update public.business_sessions
  set ai_readiness_claimed_at = now(),
      ai_readiness_claim_id = claim_id,
      updated_at = now()
  where id = target.id;
  return jsonb_build_object('ok', true, 'state', 'claimed', 'claim_id', claim_id);
end;
$$;

-- Remove the pre-claim-token overload if this migration is replayed after an
-- interrupted development deployment.
drop function if exists public.hintily_ai_finish_readiness(uuid, uuid, boolean);

create or replace function public.hintily_ai_finish_readiness(
  requested_session_id uuid,
  requested_user_id uuid,
  requested_claim_id uuid,
  succeeded boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.business_sessions
  set ai_ready_at = case when succeeded then coalesce(ai_ready_at, now()) else ai_ready_at end,
      ai_readiness_claimed_at = null,
      ai_readiness_claim_id = null,
      updated_at = now()
  where id = requested_session_id
    and user_id = requested_user_id
    and ai_readiness_claim_id = requested_claim_id;
end;
$$;

create or replace function public.hintily_ai_begin_request(
  requested_session_id uuid,
  requested_user_id uuid,
  requested_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.business_sessions%rowtype;
  rate public.hintily_ai_rate_windows%rowtype;
  active_requests integer;
begin
  if requested_session_id is null or requested_user_id is null
     or requested_request_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  select * into target
  from public.business_sessions
  where id = requested_session_id and user_id = requested_user_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if target.status <> 'active' then
    return jsonb_build_object('ok', false, 'error', 'session_not_active');
  end if;

  -- Managed AI is available only while this same Hintily session has a
  -- started, renewable Deepgram lease. An activated session by itself is not
  -- sufficient authorization.
  if not exists (
    select 1
    from public.deepgram_stream_leases d
    where d.business_session_id = target.id
      and d.user_id = requested_user_id
      and d.started_at is not null
      and d.expires_at > now()
  ) then
    return jsonb_build_object('ok', false, 'error', 'metered_stream_required');
  end if;

  delete from public.hintily_ai_request_leases
  where expires_at <= now();

  select count(*) into active_requests
  from public.hintily_ai_request_leases
  where business_session_id = target.id and expires_at > now();
  if active_requests >= 3 then
    return jsonb_build_object('ok', false, 'error', 'too_many_concurrent_requests');
  end if;

  insert into public.hintily_ai_rate_windows(
    business_session_id, user_id, window_started_at, request_count
  ) values (target.id, requested_user_id, now(), 0)
  on conflict (business_session_id) do nothing;

  select * into rate
  from public.hintily_ai_rate_windows
  where business_session_id = target.id
  for update;

  if rate.window_started_at <= now() - interval '1 minute' then
    update public.hintily_ai_rate_windows
    set window_started_at = now(), request_count = 1, updated_at = now()
    where business_session_id = target.id;
  elsif rate.request_count >= 30 then
    return jsonb_build_object('ok', false, 'error', 'rate_limit_exceeded');
  else
    update public.hintily_ai_rate_windows
    set request_count = request_count + 1, updated_at = now()
    where business_session_id = target.id;
  end if;

  insert into public.hintily_ai_request_leases(
    request_id, business_session_id, user_id, expires_at
  ) values (
    requested_request_id, target.id, requested_user_id, now() + interval '60 seconds'
  )
  on conflict (request_id) do nothing;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'duplicate_request');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.hintily_ai_end_request(
  requested_session_id uuid,
  requested_user_id uuid,
  requested_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.hintily_ai_request_leases
  where request_id = requested_request_id
    and business_session_id = requested_session_id
    and user_id = requested_user_id;
end;
$$;

revoke all on function public.hintily_ai_claim_readiness(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.hintily_ai_finish_readiness(uuid, uuid, uuid, boolean)
  from public, anon, authenticated;
revoke all on function public.hintily_ai_begin_request(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.hintily_ai_end_request(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.hintily_ai_claim_readiness(uuid, uuid) to service_role;
grant execute on function public.hintily_ai_finish_readiness(uuid, uuid, uuid, boolean) to service_role;
grant execute on function public.hintily_ai_begin_request(uuid, uuid, uuid) to service_role;
grant execute on function public.hintily_ai_end_request(uuid, uuid, uuid) to service_role;

commit;
