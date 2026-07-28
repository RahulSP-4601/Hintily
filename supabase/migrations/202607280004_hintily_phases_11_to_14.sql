begin;

-- Phase 13 hardening. These counters are deliberately server-owned and contain
-- no request content, transcripts, prompts, answers, resumes, or job details.
create table if not exists public.hintily_action_rate_limits (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, action)
);

alter table public.hintily_action_rate_limits enable row level security;
revoke all on table public.hintily_action_rate_limits from public, anon, authenticated;

create or replace function public.hintily_consume_action_rate(
  requested_action text,
  requested_limit integer,
  requested_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  current_row public.hintily_action_rate_limits%rowtype;
  safe_limit integer;
  safe_window integer;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  if requested_action not in (
    'account_refresh', 'checkout', 'session_authorize', 'session_stream_ready',
    'session_activate', 'session_post_processing', 'session_complete',
    'deepgram_authorize'
  ) then
    raise exception 'invalid_rate_action';
  end if;
  -- Limits are selected here, never trusted from the authenticated caller.
  -- The arguments remain for forward-compatible Edge clients and are bounded
  -- downward only, so direct RPC calls cannot raise their own allowance.
  safe_limit := case requested_action
    when 'checkout' then 5
    when 'session_authorize' then 12
    when 'session_stream_ready' then 30
    when 'session_activate' then 12
    when 'session_post_processing' then 12
    when 'session_complete' then 20
    when 'deepgram_authorize' then 12
    else 60
  end;
  safe_window := case when requested_action = 'checkout' then 600 else 60 end;
  safe_limit := least(safe_limit, greatest(1, requested_limit));
  safe_window := greatest(
    safe_window,
    least(86400, greatest(10, requested_window_seconds))
  );

  insert into public.hintily_action_rate_limits(user_id, action, request_count)
  values (caller, requested_action, 0)
  on conflict (user_id, action) do nothing;

  select * into current_row
  from public.hintily_action_rate_limits
  where user_id = caller and action = requested_action
  for update;

  if current_row.window_started_at <= now() - make_interval(secs => safe_window) then
    update public.hintily_action_rate_limits
    set window_started_at = now(), request_count = 1, updated_at = now()
    where user_id = caller and action = requested_action;
    return true;
  end if;
  if current_row.request_count >= safe_limit then return false; end if;
  update public.hintily_action_rate_limits
  set request_count = request_count + 1, updated_at = now()
  where user_id = caller and action = requested_action;
  return true;
end;
$$;

revoke all on function public.hintily_consume_action_rate(text, integer, integer)
  from public, anon;
grant execute on function public.hintily_consume_action_rate(text, integer, integer)
  to authenticated;

-- Ephemeral operational data can be removed without touching accounts,
-- purchases, entitlements, allocations, or completed business-session audit.
create or replace function public.hintily_cleanup_ephemeral_security_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_role text := auth.role();
  rate_rows integer;
  lease_rows integer;
begin
  if caller_role <> 'service_role' then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
  delete from public.hintily_action_rate_limits
  where updated_at < now() - interval '7 days';
  get diagnostics rate_rows = row_count;
  delete from public.deepgram_stream_leases
  where expires_at < now() - interval '24 hours';
  get diagnostics lease_rows = row_count;
  return jsonb_build_object(
    'rate_limit_rows_deleted', rate_rows,
    'stream_lease_rows_deleted', lease_rows
  );
end;
$$;

revoke all on function public.hintily_cleanup_ephemeral_security_data()
  from public, anon, authenticated;
grant execute on function public.hintily_cleanup_ephemeral_security_data()
  to service_role;

create index if not exists hintily_action_rate_limits_updated_idx
  on public.hintily_action_rate_limits(updated_at);
create index if not exists session_allocations_available_selection_idx
  on public.session_allocations(user_id, created_at, id)
  where status = 'available' and consumed_at is null;
create index if not exists business_sessions_user_active_idx
  on public.business_sessions(user_id, updated_at desc)
  where status in ('pending', 'active', 'post_processing');

commit;
