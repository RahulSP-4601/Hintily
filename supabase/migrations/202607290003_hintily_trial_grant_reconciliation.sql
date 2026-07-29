begin;

-- Reconcile free-session creation on databases that predate Hintily.  The
-- previous implementation used an ON CONFLICT inference against a partial
-- index.  Older projects can have an equivalent constraint with a different
-- shape/name, which makes PostgreSQL reject the statement before either row
-- is committed.  Serialize on the auth user instead and resolve the grant by
-- its account-bound source.
create or replace function public.hintily_ensure_trial()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  entitlement_id uuid;
  is_google_identity boolean := false;
begin
  if caller is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;

  -- The auth row is also the per-account mutex.  Concurrent first-launch
  -- requests must not be able to create two grants.
  select
    coalesce(u.raw_app_meta_data ->> 'provider' = 'google', false)
    or coalesce((u.raw_app_meta_data -> 'providers') ? 'google', false)
  into is_google_identity
  from auth.users u
  where u.id = caller
    and u.email_confirmed_at is not null
  for update;

  if not coalesce(is_google_identity, false) then
    raise exception 'verified_google_identity_required' using errcode = '42501';
  end if;

  select e.id
  into entitlement_id
  from public.entitlements e
  where e.user_id = caller
    and e.source = 'free_trial'
  order by e.created_at
  limit 1
  for update;

  if entitlement_id is null then
    insert into public.entitlements(
      user_id,
      plan_code,
      plan_name,
      status,
      unlimited,
      source,
      source_reference
    )
    values (
      caller,
      'free_trial',
      'One 20-Minute Session',
      'trial',
      false,
      'free_trial',
      caller::text
    )
    returning id into entitlement_id;
  end if;

  -- Historical use is deliberately included in the existence check. Deleting
  -- or consuming the allocation must never make an account trial-eligible
  -- again.
  if not exists (
    select 1
    from public.session_allocations a
    where a.user_id = caller
      and (a.kind = 'trial' or a.session_type = 'free')
  ) then
    insert into public.session_allocations(
      user_id,
      entitlement_id,
      kind,
      session_type,
      status,
      allocated_seconds,
      maximum_seconds,
      consumed_seconds
    )
    values (
      caller,
      entitlement_id,
      'trial',
      'free',
      'available',
      1200,
      1200,
      0
    );
  end if;

  return public.hintily_account_state();
end;
$$;

revoke all on function public.hintily_ensure_trial() from public, anon;
grant execute on function public.hintily_ensure_trial() to authenticated;

commit;
