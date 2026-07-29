-- Keep Google/Supabase account creation available when this project is
-- upgraded from a legacy user_profiles schema. Profile metadata is useful but
-- must never be allowed to roll back the authoritative auth.users insert.

begin;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    insert into public.user_profiles(user_id, display_name, avatar_url)
    select
      new.id,
      left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), 120),
      left(coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'), 2048)
    where not exists (
      select 1
      from public.user_profiles profiles
      where profiles.user_id = new.id
    );
  exception when others then
    -- Supabase reports any uncaught auth.users trigger exception as
    -- "Database error saving new user". Authentication and Hintily's
    -- user-id-based entitlement provisioning do not require this optional
    -- presentation row, so record the problem without rejecting sign-in.
    raise warning 'Hintily profile creation skipped for auth user %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_hintily on auth.users;
create trigger on_auth_user_created_hintily
after insert on auth.users
for each row execute function public.create_profile_for_new_user();

commit;
