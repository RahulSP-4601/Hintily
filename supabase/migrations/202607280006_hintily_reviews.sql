begin;

alter table public.review_prompt_state
  add column if not exists last_dismissed_at timestamptz,
  add column if not exists session_count integer not null default 0,
  add column if not exists total_usage_ms bigint not null default 0;

alter table public.reviews
  add column if not exists testimonial_name text,
  add column if not exists testimonial_role text,
  add column if not exists testimonial_company text,
  add column if not exists display_name_publicly boolean not null default false,
  add column if not exists app_version text,
  add column if not exists platform text,
  add column if not exists build_channel text;

create or replace function public.hintily_review_record_event(
  requested_event text,
  requested_usage_ms bigint default 0
)
returns public.review_prompt_state
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  result public.review_prompt_state%rowtype;
  current_time timestamptz := now();
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  if requested_event not in ('session', 'dismiss_later', 'dont_show_again', 'shown') then
    raise exception 'invalid_review_event';
  end if;
  insert into public.review_prompt_state(user_id) values (caller)
  on conflict (user_id) do nothing;

  update public.review_prompt_state
  set
    session_count = session_count + case when requested_event = 'session' then 1 else 0 end,
    total_usage_ms = total_usage_ms + case
      when requested_event = 'session' then least(greatest(requested_usage_ms, 0), 21600000)
      else 0
    end,
    dismissed_count = dismissed_count + case
      when requested_event in ('dismiss_later', 'dont_show_again') then 1 else 0
    end,
    dont_show_again = dont_show_again or requested_event = 'dont_show_again',
    last_prompted_at = case when requested_event = 'shown' then current_time else last_prompted_at end,
    last_dismissed_at = case
      when requested_event in ('dismiss_later', 'dont_show_again') then current_time
      else last_dismissed_at
    end,
    next_eligible_at = case
      when requested_event = 'dismiss_later' then current_time + interval '7 days'
      when requested_event = 'dont_show_again' then null
      else next_eligible_at
    end,
    updated_at = current_time
  where user_id = caller
  returning * into result;
  return result;
end;
$$;

create or replace function public.hintily_submit_review(
  requested_rating integer,
  requested_review_text text,
  requested_app_version text,
  requested_platform text,
  requested_build_channel text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  review_id uuid;
begin
  if caller is null then raise exception 'unauthorized' using errcode = '28000'; end if;
  if requested_rating < 1 or requested_rating > 5 then raise exception 'invalid_rating'; end if;
  if char_length(coalesce(requested_review_text, '')) > 300 then raise exception 'review_too_long'; end if;
  insert into public.reviews(
    user_id, rating, review_text, app_version, platform, build_channel
  ) values (
    caller,
    requested_rating,
    nullif(btrim(requested_review_text), ''),
    left(requested_app_version, 40),
    left(requested_platform, 20),
    left(requested_build_channel, 40)
  ) returning id into review_id;
  insert into public.review_prompt_state(user_id, has_reviewed, dont_show_again)
  values (caller, true, true)
  on conflict (user_id) do update
  set has_reviewed = true, dont_show_again = true,
      next_eligible_at = null, updated_at = now();
  return review_id;
end;
$$;

revoke all on function public.hintily_review_record_event(text, bigint)
  from public, anon;
grant execute on function public.hintily_review_record_event(text, bigint)
  to authenticated;
revoke all on function public.hintily_submit_review(integer, text, text, text, text)
  from public, anon;
grant execute on function public.hintily_submit_review(integer, text, text, text, text)
  to authenticated;

commit;
