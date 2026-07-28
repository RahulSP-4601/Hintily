begin;

-- Extend the server-owned action allowlist for Hintily's Google Calendar
-- OAuth proxy. The desktop cannot raise these limits through RPC arguments.
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
    'deepgram_authorize', 'calendar_exchange', 'calendar_refresh',
    'review_read', 'review_event', 'review_submit', 'review_testimonial'
  ) then
    raise exception 'invalid_rate_action';
  end if;
  safe_limit := case requested_action
    when 'checkout' then 5
    when 'session_authorize' then 12
    when 'session_stream_ready' then 30
    when 'session_activate' then 12
    when 'session_post_processing' then 12
    when 'session_complete' then 20
    when 'deepgram_authorize' then 12
    when 'calendar_exchange' then 5
    when 'calendar_refresh' then 20
    when 'review_read' then 30
    when 'review_event' then 30
    when 'review_submit' then 5
    when 'review_testimonial' then 10
    else 60
  end;
  safe_window := case
    when requested_action in ('checkout', 'review_submit') then 600
    else 60
  end;
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

commit;
