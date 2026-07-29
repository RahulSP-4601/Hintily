-- Reconcile the legacy user_profiles identity shape with Hintily.
--
-- The existing Supabase project uses:
--   id           uuid primary key / auth.users foreign key
--   email        text
--   display_name text
-- while Hintily's first migrations added user_id, avatar_url, and locale.
--
-- Keep both identity columns populated so old policies/integrations and the
-- Hintily application can safely coexist during the migration.

begin;

create extension if not exists pgcrypto;

alter table public.user_profiles
  add column if not exists id uuid,
  add column if not exists email text,
  add column if not exists user_id uuid,
  add column if not exists display_name text,
  add column if not exists avatar_url text,
  add column if not exists locale text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

-- Repair rows created by either historical schema before tightening the
-- trigger invariant. Compute the canonical identity once so a row where both
-- historical identity columns are null cannot retain a null user_id.
with canonical_profiles as (
  select
    ctid,
    coalesce(id, user_id, gen_random_uuid()) as canonical_user_id
  from public.user_profiles
)
update public.user_profiles profiles
set
  id = canonical.canonical_user_id,
  user_id = canonical.canonical_user_id,
  created_at = coalesce(profiles.created_at, now()),
  updated_at = coalesce(profiles.updated_at, now())
from canonical_profiles canonical
where profiles.ctid = canonical.ctid;

alter table public.user_profiles
  alter column id set default gen_random_uuid(),
  alter column created_at set default now(),
  alter column updated_at set default now();

-- The auth trigger performs an explicit existence check instead of relying on
-- ON CONFLICT, so this remains compatible with legacy projects where user_id
-- was added after id and is not itself the primary key.
create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  profile_name text := left(
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    120
  );
  profile_avatar text := left(
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'),
    2048
  );
begin
  begin
    insert into public.user_profiles(
      id,
      email,
      display_name,
      user_id,
      avatar_url,
      created_at,
      updated_at
    )
    select
      new.id,
      left(new.email, 320),
      profile_name,
      new.id,
      profile_avatar,
      now(),
      now()
    where not exists (
      select 1
      from public.user_profiles profiles
      where profiles.id = new.id or profiles.user_id = new.id
    );
  exception
    when unique_violation or not_null_violation or check_violation
      or foreign_key_violation or undefined_column then
      -- A presentation-profile incompatibility must not roll back the
      -- authoritative auth.users record. Existing accounts are repaired by
      -- the reconciliation/backfill below; unexpected failures still surface.
      raise warning 'Hintily profile creation skipped for auth user % [%]: %',
        new.id, sqlstate, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_hintily on auth.users;
create trigger on_auth_user_created_hintily
after insert on auth.users
for each row execute function public.create_profile_for_new_user();

-- The affected Google user already exists in auth.users because the previous
-- hardening migration allowed authentication to complete. Backfill every such
-- account without overwriting profile edits.
insert into public.user_profiles(
  id,
  email,
  display_name,
  user_id,
  avatar_url,
  created_at,
  updated_at
)
select
  users.id,
  left(users.email, 320),
  left(coalesce(
    users.raw_user_meta_data ->> 'full_name',
    users.raw_user_meta_data ->> 'name'
  ), 120),
  users.id,
  left(coalesce(
    users.raw_user_meta_data ->> 'avatar_url',
    users.raw_user_meta_data ->> 'picture'
  ), 2048),
  coalesce(users.created_at, now()),
  now()
from auth.users users
where not exists (
  select 1
  from public.user_profiles profiles
  where profiles.id = users.id or profiles.user_id = users.id
);

commit;

-- Verification: every auth user should now return exactly one matching row.
select
  users.id as auth_user_id,
  users.email as auth_email,
  profiles.id as profile_id,
  profiles.user_id as profile_user_id,
  profiles.email as profile_email,
  profiles.display_name
from auth.users users
left join public.user_profiles profiles
  on profiles.id = users.id or profiles.user_id = users.id
order by users.created_at desc;
