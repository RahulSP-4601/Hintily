begin;

-- Phase 6 account detail.  Keep the original account-state RPC stable for
-- older desktop builds and expose the selected entitlement explicitly to new
-- clients.
create or replace function public.hintily_account_state_v2()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  state jsonb;
  entitlement jsonb;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  state := public.hintily_account_state();
  select jsonb_build_object(
    'plan_code', e.plan_code,
    'plan_name', e.plan_name,
    'status', case
      when e.ends_at is not null and e.ends_at <= now() then 'expired'
      else e.status
    end,
    'starts_at', e.starts_at,
    'ends_at', e.ends_at,
    'lifetime', e.ends_at is null
  )
  into entitlement
  from public.entitlements e
  where e.user_id = caller and e.unlimited
  order by
    (e.status = 'active' and e.starts_at <= now()
      and (e.ends_at is null or e.ends_at > now())) desc,
    e.updated_at desc
  limit 1;
  return state || jsonb_build_object('unlimited_entitlement', entitlement);
end;
$$;

revoke all on function public.hintily_account_state_v2() from public, anon;
grant execute on function public.hintily_account_state_v2() to authenticated;

-- Bind the business session to its product surface.  The one-argument RPC is
-- retained only as an implementation detail so old clients cannot create an
-- unbound/defaulted session.
create or replace function public.hintily_authorize_session(
  requested_client_session_id uuid,
  requested_surface text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  result jsonb;
  target public.business_sessions%rowtype;
begin
  if requested_surface not in ('interview_helper', 'meeting') then
    raise exception 'invalid_session_surface';
  end if;
  result := public.hintily_authorize_session(requested_client_session_id);
  select * into target
  from public.business_sessions
  where id = (result ->> 'session_id')::uuid and user_id = auth.uid()
  for update;
  if not found then raise exception 'session_not_found'; end if;
  if coalesce((result ->> 'reconnected')::boolean, false)
     and target.surface <> requested_surface then
    raise exception 'session_surface_mismatch';
  end if;
  update public.business_sessions
  set surface = requested_surface, updated_at = now()
  where id = target.id and status = 'pending';
  return result || jsonb_build_object('surface', requested_surface);
end;
$$;

revoke all on function public.hintily_authorize_session(uuid) from authenticated;
revoke all on function public.hintily_authorize_session(uuid, text) from public, anon;
grant execute on function public.hintily_authorize_session(uuid, text) to authenticated;

-- Activation is the consumption boundary.  Enforce provider readiness in the
-- transaction itself so an authenticated caller cannot bypass the Edge
-- Function/desktop startup sequence by invoking this RPC directly.
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
  ready_channels integer;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into target from public.business_sessions
  where id = requested_session_id and user_id = caller for update;
  if not found then raise exception 'session_not_found'; end if;
  if target.status = 'active' then
    return jsonb_build_object('session_id', target.id, 'status', 'active');
  end if;
  if target.status <> 'pending' then raise exception 'session_not_activatable'; end if;
  if target.ai_ready_at is null then raise exception 'ai_provider_not_ready'; end if;

  select count(distinct channel) into ready_channels
  from public.deepgram_stream_leases
  where business_session_id = target.id
    and user_id = caller
    and channel in ('interviewer', 'user')
    and started_at is not null
    and expires_at > now();
  if ready_channels <> 2 then raise exception 'stt_providers_not_ready'; end if;

  if target.allocation_id is not null then
    update public.session_allocations
    set status = 'active',
        activated_at = coalesce(activated_at, now()),
        updated_at = now()
    where id = target.allocation_id and status = 'reserved';
    if not found then raise exception 'session_not_activatable'; end if;
  else
    select exists(
      select 1 from public.entitlements e
      where e.user_id = caller and e.unlimited and e.status = 'active'
        and e.starts_at <= now() and (e.ends_at is null or e.ends_at > now())
    ) into unlimited_access;
    if not unlimited_access then raise exception 'session_not_activatable'; end if;
  end if;

  update public.business_sessions
  set status = 'active',
      started_at = coalesce(started_at, now()),
      activation_completed_at = coalesce(activation_completed_at, now()),
      last_heartbeat_at = now(),
      updated_at = now()
  where id = target.id;
  return jsonb_build_object('session_id', target.id, 'status', 'active');
end;
$$;

revoke all on function public.hintily_activate_session(uuid) from public, anon;
grant execute on function public.hintily_activate_session(uuid) to authenticated;

-- Deepgram leases may be opened while a session is pending.  Billing starts
-- only after both channels are ready and the desktop activates the session.
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
  select * into target from public.business_sessions
  where id = requested_session_id and user_id = caller for update;
  if not found or target.status not in ('pending', 'active') then
    raise exception 'session_not_ready';
  end if;
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
       or public.deepgram_stream_leases.lease_id = excluded.lease_id
       or (
         public.deepgram_stream_leases.lease_owner_id = excluded.lease_owner_id
         and public.deepgram_stream_leases.updated_at <= now() - interval '25 seconds'
       );
  if not exists (
    select 1 from public.deepgram_stream_leases
    where business_session_id = target.id and channel = requested_channel
      and lease_id = requested_lease_id
  ) then
    raise exception 'stream_channel_in_use' using errcode = 'P0001';
  end if;
  return jsonb_build_object('acquired', true, 'lease_id', requested_lease_id);
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
  target_status text;
  already_metering boolean;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select status into target_status from public.business_sessions
  where id = requested_session_id and user_id = caller for update;
  if target_status not in ('pending', 'active') then raise exception 'session_not_ready'; end if;
  select exists (
    select 1 from public.deepgram_stream_leases
    where business_session_id = requested_session_id and user_id = caller
      and started_at is not null and expires_at > now()
      and not (channel = requested_channel and lease_id = requested_lease_id)
  ) into already_metering;
  update public.deepgram_stream_leases
  set started_at = coalesce(started_at, now()),
      expires_at = now() + interval '30 seconds', updated_at = now()
  where business_session_id = requested_session_id and user_id = caller
    and channel = requested_channel and lease_id = requested_lease_id
    and expires_at > now();
  if not found then raise exception 'stream_lease_expired'; end if;
  if target_status = 'active' and not already_metering then
    update public.business_sessions
    set last_heartbeat_at = now(), updated_at = now()
    where id = requested_session_id and user_id = caller;
  end if;
end;
$$;

-- A relay socket opening only proves that the desktop reached the Edge
-- Function. Activation must wait until the relay has opened Deepgram upstream
-- and marked the matching channel lease ready.
create or replace function public.hintily_stream_channel_ready(
  requested_session_id uuid,
  requested_channel text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  if requested_channel not in ('interviewer', 'user') then
    raise exception 'invalid_stream_channel';
  end if;
  return exists (
    select 1
    from public.business_sessions s
    join public.deepgram_stream_leases l
      on l.business_session_id = s.id and l.user_id = s.user_id
    where s.id = requested_session_id
      and s.user_id = caller
      and s.status in ('pending', 'active')
      and l.channel = requested_channel
      and l.started_at is not null
      and l.expires_at > now()
  );
end;
$$;
revoke all on function public.hintily_stream_channel_ready(uuid, text)
  from public, anon;
grant execute on function public.hintily_stream_channel_ready(uuid, text)
  to authenticated;

-- The relay owns the clock and sequence.  Pending heartbeats only renew the
-- lease; they never consume a session before provider startup succeeds.
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
  elapsed integer := 0;
  charge integer := 0;
  next_sequence integer;
  remaining integer;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into target from public.business_sessions
  where id = requested_session_id and user_id = caller for update;
  if not found or target.status not in ('pending', 'active') then
    raise exception 'session_not_ready';
  end if;
  update public.deepgram_stream_leases
  set expires_at = now() + interval '30 seconds', updated_at = now()
  where business_session_id = target.id and user_id = caller
    and channel = requested_channel and lease_id = requested_lease_id
    and started_at is not null and expires_at > now();
  if not found then raise exception 'stream_lease_expired'; end if;
  if target.status = 'pending' then
    return jsonb_build_object(
      'accepted_seconds', 0, 'remaining_seconds', null,
      'exhausted', false, 'pending', true
    );
  end if;

  elapsed := least(30, greatest(0, floor(extract(epoch from
    (now() - coalesce(target.last_heartbeat_at, now()))))::integer));
  if target.allocation_id is not null then
    select * into allocation from public.session_allocations
    where id = target.allocation_id and status = 'active' for update;
    if not found then raise exception 'session_not_active'; end if;
    charge := least(elapsed,
      greatest(allocation.maximum_seconds - allocation.consumed_seconds, 0));
    remaining := greatest(allocation.maximum_seconds - allocation.consumed_seconds - charge, 0);
  else
    if not exists (
      select 1 from public.entitlements e
      where e.user_id = caller and e.unlimited and e.status = 'active'
        and e.starts_at <= now() and (e.ends_at is null or e.ends_at > now())
    ) then
      update public.business_sessions set status = 'failed',
        failure_code = 'payment_access_revoked',
        completion_reason = 'payment_access_revoked',
        completed_at = coalesce(completed_at, now()), updated_at = now()
      where id = target.id;
      delete from public.deepgram_stream_leases where business_session_id = target.id;
      return jsonb_build_object(
        'accepted_seconds', 0, 'remaining_seconds', 0,
        'exhausted', true, 'revoked', true
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
    update public.business_sessions
    set consumed_seconds = consumed_seconds + charge,
        last_heartbeat_at = now(), updated_at = now()
    where id = target.id;
    if target.allocation_id is not null then
      update public.session_allocations
      set consumed_seconds = consumed_seconds + charge,
          status = case when consumed_seconds + charge >= maximum_seconds
            then 'consumed' else 'active' end,
          updated_at = now()
      where id = target.allocation_id;
      if remaining = 0 then
        update public.business_sessions
        set status = 'completed', completion_reason = 'time_exhausted',
            completed_at = coalesce(completed_at, now()), updated_at = now()
        where id = target.id;
        delete from public.deepgram_stream_leases where business_session_id = target.id;
      end if;
    end if;
  end if;
  return jsonb_build_object(
    'accepted_seconds', charge, 'remaining_seconds', remaining,
    'exhausted', target.allocation_id is not null and remaining = 0
  );
end;
$$;

-- Stop-time AI must not keep the metered Deepgram relays alive. A grant can
-- only be minted for an already-active Meeting session while both of its live
-- streams are present, and is bounded by both time and request count.
alter table public.business_sessions
  add column if not exists post_processing_until timestamptz,
  add column if not exists post_processing_requests_remaining integer
    check (post_processing_requests_remaining is null
      or post_processing_requests_remaining between 0 and 64);

create or replace function public.hintily_begin_post_processing(
  requested_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target public.business_sessions%rowtype;
  ready_channels integer;
  grant_until timestamptz := now() + interval '10 minutes';
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  select * into target
  from public.business_sessions
  where id = requested_session_id and user_id = caller
  for update;
  if not found or target.status <> 'active' or target.surface <> 'meeting' then
    raise exception 'post_processing_not_allowed';
  end if;
  select count(distinct channel) into ready_channels
  from public.deepgram_stream_leases
  where business_session_id = target.id
    and user_id = caller
    and channel in ('interviewer', 'user')
    and started_at is not null
    and expires_at > now();
  if ready_channels <> 2 then raise exception 'post_processing_not_allowed'; end if;
  update public.business_sessions
  set post_processing_until = grant_until,
      post_processing_requests_remaining = 64,
      updated_at = now()
  where id = target.id;
  return jsonb_build_object(
    'session_id', target.id,
    'post_processing_until', grant_until,
    'requests_remaining', 64
  );
end;
$$;
revoke all on function public.hintily_begin_post_processing(uuid)
  from public, anon;
grant execute on function public.hintily_begin_post_processing(uuid)
  to authenticated;

create or replace function public.hintily_finalize_session(
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
  result jsonb;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  -- Revoke post-meeting AI and complete the business session in this single
  -- database transaction. Any failure rolls back both operations.
  update public.business_sessions
  set post_processing_until = null,
      post_processing_requests_remaining = 0,
      updated_at = now()
  where id = requested_session_id and user_id = caller;
  if not found then raise exception 'session_not_found'; end if;
  delete from public.hintily_ai_request_leases
  where business_session_id = requested_session_id and user_id = caller;
  result := public.hintily_complete_session(
    requested_session_id,
    requested_failure_code
  );
  return result;
end;
$$;
revoke all on function public.hintily_finalize_session(uuid, text)
  from public, anon;
grant execute on function public.hintily_finalize_session(uuid, text)
  to authenticated;
-- All external completion must pass through the atomic finalizer above.
-- The function owner can still invoke this helper from the security-definer
-- finalizer, but authenticated clients cannot bypass grant revocation.
revoke all on function public.hintily_complete_session(uuid, text)
  from public, anon, authenticated;

-- Four-argument overload used by the current managed gateway. Live requests
-- require a renewable Deepgram lease; post-meeting requests require the
-- bounded grant above. The legacy three-argument overload remains for a
-- rolling Edge deployment and continues to enforce live streams only.
create or replace function public.hintily_ai_begin_request(
  requested_session_id uuid,
  requested_user_id uuid,
  requested_request_id uuid,
  requested_purpose text
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
  live_stream boolean;
  post_processing_request boolean := requested_purpose = 'post_meeting';
begin
  if requested_session_id is null or requested_user_id is null
     or requested_request_id is null
     or requested_purpose not in ('live', 'post_meeting') then
    return jsonb_build_object('ok', false, 'error', 'invalid_request');
  end if;

  select * into target
  from public.business_sessions
  where id = requested_session_id and user_id = requested_user_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'session_not_found');
  end if;
  if (post_processing_request and target.status not in ('active', 'completed'))
     or (not post_processing_request and target.status <> 'active') then
    return jsonb_build_object('ok', false, 'error', 'session_not_active');
  end if;

  select exists (
    select 1 from public.deepgram_stream_leases d
    where d.business_session_id = target.id
      and d.user_id = requested_user_id
      and d.started_at is not null
      and d.expires_at > now()
  ) into live_stream;

  if post_processing_request then
    if target.surface <> 'meeting'
       or target.post_processing_until is null
       or target.post_processing_until <= now()
       or coalesce(target.post_processing_requests_remaining, 0) <= 0 then
      return jsonb_build_object('ok', false, 'error', 'post_processing_not_allowed');
    end if;
  elsif not live_stream then
    return jsonb_build_object('ok', false, 'error', 'metered_stream_required');
  end if;

  delete from public.hintily_ai_request_leases where expires_at <= now();
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
  select * into rate from public.hintily_ai_rate_windows
  where business_session_id = target.id for update;
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
  ) on conflict (request_id) do nothing;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'duplicate_request');
  end if;
  if post_processing_request then
    update public.business_sessions
    set post_processing_requests_remaining =
          post_processing_requests_remaining - 1,
        updated_at = now()
    where id = target.id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.hintily_ai_begin_request(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.hintily_ai_begin_request(uuid, uuid, uuid, text)
  to service_role;

-- Privacy-safe AI accounting: no prompts, transcripts, screenshots or model
-- responses are stored here.
create table if not exists public.hintily_ai_usage_events (
  request_id uuid primary key,
  business_session_id uuid not null references public.business_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  model text not null,
  status text not null check (status in ('succeeded', 'failed', 'cancelled')),
  input_characters integer not null default 0 check (input_characters >= 0),
  output_characters integer not null default 0 check (output_characters >= 0),
  image_count integer not null default 0 check (image_count >= 0),
  latency_ms integer not null default 0 check (latency_ms >= 0),
  provider_attempts integer not null default 1 check (provider_attempts between 1 and 2),
  created_at timestamptz not null default now()
);
alter table public.hintily_ai_usage_events enable row level security;
revoke all on public.hintily_ai_usage_events from public, anon, authenticated;

create or replace function public.hintily_ai_record_usage(
  requested_request_id uuid,
  requested_session_id uuid,
  requested_user_id uuid,
  requested_provider text,
  requested_model text,
  requested_status text,
  requested_input_characters integer,
  requested_output_characters integer,
  requested_image_count integer,
  requested_latency_ms integer,
  requested_provider_attempts integer
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.hintily_ai_usage_events(
    request_id, business_session_id, user_id, provider, model, status,
    input_characters, output_characters, image_count, latency_ms, provider_attempts
  ) values (
    requested_request_id, requested_session_id, requested_user_id,
    left(requested_provider, 40), left(requested_model, 120), requested_status,
    greatest(requested_input_characters, 0), greatest(requested_output_characters, 0),
    greatest(requested_image_count, 0), greatest(requested_latency_ms, 0),
    least(2, greatest(requested_provider_attempts, 1))
  ) on conflict (request_id) do nothing;
$$;
revoke all on function public.hintily_ai_record_usage(
  uuid, uuid, uuid, text, text, text, integer, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.hintily_ai_record_usage(
  uuid, uuid, uuid, text, text, text, integer, integer, integer, integer, integer
) to service_role;

-- Policy: a partial refund is audit-only and does not revoke already-granted
-- access.  A full refund revokes every unused allocation (or the unlimited
-- entitlement) through hintily_apply_dodo_event.
create or replace function public.hintily_record_dodo_webhook_failure(
  event_id text,
  event_type text,
  event_payload_sha256 text,
  safe_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if event_id is null or length(event_id) > 200 then return; end if;
  insert into public.webhook_events(
    provider, provider_event_id, event_type, status, payload_sha256,
    attempts, error_code
  ) values (
    'dodo', event_id, left(coalesce(event_type, 'unknown'), 120), 'failed',
    event_payload_sha256, 1, left(coalesce(safe_error_code, 'processing_failed'), 80)
  )
  on conflict (provider, provider_event_id) where provider_event_id is not null
  do update set
    status = 'failed',
    processed_at = null,
    error_code = excluded.error_code,
    attempts = public.webhook_events.attempts + 1
  where public.webhook_events.status not in ('processed', 'ignored');
end;
$$;
revoke all on function public.hintily_record_dodo_webhook_failure(
  text, text, text, text
) from public, anon, authenticated;
grant execute on function public.hintily_record_dodo_webhook_failure(
  text, text, text, text
) to service_role;

create or replace function public.hintily_apply_dodo_partial_refund(
  event_id text,
  event_occurred_at timestamptz,
  event_payload_sha256 text,
  payment_id text,
  refund_delta_minor bigint,
  safe_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  webhook_row uuid;
  purchase_row public.purchases%rowtype;
  prior_refunded bigint;
  cumulative_refunded bigint;
  effective_event_at timestamptz;
begin
  if event_id is null or length(event_id) > 200 or event_occurred_at is null
     or payment_id is null or refund_delta_minor <= 0 then
    raise exception 'invalid_partial_refund';
  end if;
  select * into purchase_row from public.purchases
  where provider = 'dodo' and provider_payment_id = payment_id for update;
  if not found or purchase_row.amount_minor is null then
    raise exception 'purchase_not_found';
  end if;
  prior_refunded := case
    when (purchase_row.metadata ->> 'refunded_amount_minor') ~ '^[0-9]+$'
      then (purchase_row.metadata ->> 'refunded_amount_minor')::bigint
    else 0
  end;
  cumulative_refunded := prior_refunded + refund_delta_minor;
  effective_event_at := greatest(
    coalesce(purchase_row.provider_event_at, event_occurred_at),
    event_occurred_at
  );
  if cumulative_refunded >= purchase_row.amount_minor then
    -- Hand this event to the terminal handler in a state it can atomically
    -- claim. This also reopens a durable failed partial-refund delivery.
    insert into public.webhook_events(
      provider, provider_event_id, event_type, status, payload_sha256,
      attempts, error_code
    ) values (
      'dodo', event_id, 'refund.partial', 'received', event_payload_sha256,
      1, 'provider_reconciliation_required'
    )
    on conflict (provider, provider_event_id) where provider_event_id is not null
    do update set
      status = 'received',
      processed_at = null,
      payload_sha256 = excluded.payload_sha256,
      error_code = 'provider_reconciliation_required',
      attempts = public.webhook_events.attempts + 1
    where public.webhook_events.status = 'failed'
    returning id into webhook_row;
    if webhook_row is null then
      return jsonb_build_object('duplicate', true);
    end if;
    -- The general terminal-event handler owns the webhook row and access
    -- revocation. Use the newest known timestamp so an older, uniquely
    -- delivered refund delta cannot be rejected as stale after completing the
    -- cumulative full refund.
    return jsonb_build_object(
      'full_refund', true,
      'effective_event_at', effective_event_at
    );
  end if;
  insert into public.webhook_events(
    provider, provider_event_id, event_type, status, payload_sha256, attempts
  ) values (
    'dodo', event_id, 'refund.partial', 'processing', event_payload_sha256, 1
  )
  on conflict (provider, provider_event_id) where provider_event_id is not null
  do update set
    status = 'processing',
    processed_at = null,
    error_code = null,
    attempts = public.webhook_events.attempts + 1
  where public.webhook_events.status = 'failed'
  returning id into webhook_row;
  if webhook_row is null then return jsonb_build_object('duplicate', true); end if;
  update public.purchases
  set status = case
        when status in ('refunded', 'disputed') then status
        else 'partially_refunded'
      end,
      metadata = metadata || coalesce(safe_metadata, '{}'::jsonb)
        || jsonb_build_object('refunded_amount_minor', cumulative_refunded),
      provider_event_at = effective_event_at,
      updated_at = now()
  where id = purchase_row.id;
  update public.webhook_events set status = 'processed', processed_at = now()
  where id = webhook_row;
  return jsonb_build_object('processed', true, 'partial_refund', true);
exception when others then
  -- This transaction is rolled back before the caller receives the error.
  -- The Edge handler records a sanitized durable failure in a separate RPC.
  raise;
end;
$$;
revoke all on function public.hintily_apply_dodo_partial_refund(
  text, timestamptz, text, text, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.hintily_apply_dodo_partial_refund(
  text, timestamptz, text, text, bigint, jsonb
) to service_role;

-- Direct client-supplied heartbeat durations are obsolete.  Only the
-- Deepgram relay may advance the authoritative clock.
revoke all on function public.hintily_session_heartbeat(uuid, integer, integer)
  from authenticated;

commit;
