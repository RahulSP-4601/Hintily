begin;

-- The original Natively allocation table represented an already-started
-- local session, so local_session_id and ends_at were mandatory. Hintily uses
-- this table as account inventory: free and paid allocations exist before a
-- meeting/interview is authorized and may have no expiry. Requiring either
-- legacy field makes every first-login grant and Dodo pack insert roll back.
do $$
begin
  if exists (
    select 1
    from pg_attribute
    where attrelid = 'public.session_allocations'::regclass
      and attname = 'local_session_id'
      and not attisdropped
  ) then
    alter table public.session_allocations
      alter column local_session_id drop not null;
  end if;

  if exists (
    select 1
    from pg_attribute
    where attrelid = 'public.session_allocations'::regclass
      and attname = 'ends_at'
      and not attisdropped
  ) then
    alter table public.session_allocations
      alter column ends_at drop not null;
  end if;
end;
$$;

commit;
