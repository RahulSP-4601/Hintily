-- Hintily compatibility migration for the EXISTING Supabase project.
--
-- Purpose:
--   * preserve every existing row;
--   * create tables that are missing;
--   * add columns that are missing;
--   * restore the indexes, triggers, RLS policies, and financial write guards
--     expected by the rebuilt desktop application.
--
-- This migration intentionally does not drop business tables or delete data.
-- It is safe to paste into the Supabase SQL editor more than once.

begin;

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables: full definitions are used for a clean project.
-- ---------------------------------------------------------------------------

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  locale text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  plan_code text not null default 'legacy',
  plan_name text not null default 'Legacy entitlement',
  status text not null default 'active',
  unlimited boolean not null default false,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  source text not null default 'migration',
  source_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  provider text not null default 'dodo',
  provider_payment_id text,
  provider_customer_id text,
  product_code text not null default 'legacy',
  amount_minor bigint,
  currency text,
  status text not null default 'pending',
  purchased_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.session_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  entitlement_id uuid references public.entitlements(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete restrict,
  kind text not null default 'trial',
  status text not null default 'available',
  allocated_seconds integer not null default 0,
  consumed_seconds integer not null default 0,
  reserved_at timestamptz,
  activated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.business_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  allocation_id uuid references public.session_allocations(id) on delete restrict,
  status text not null default 'pending',
  client_session_id uuid not null default gen_random_uuid(),
  started_at timestamptz,
  last_heartbeat_at timestamptz,
  completed_at timestamptz,
  consumed_seconds integer not null default 0,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.usage_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  business_session_id uuid references public.business_sessions(id) on delete cascade,
  sequence_no integer not null default 0,
  active_seconds integer not null default 0,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'dodo',
  provider_event_id text,
  event_type text not null default 'unknown',
  status text not null default 'received',
  payload_sha256 text,
  error_code text,
  attempts integer not null default 0,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.review_prompt_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  has_reviewed boolean not null default false,
  dismissed_count integer not null default 0,
  dont_show_again boolean not null default false,
  last_prompted_at timestamptz,
  next_eligible_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  rating smallint,
  review_text text,
  can_use_publicly boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Existing project reconciliation: add every expected column independently.
-- Defaults populate a safe value when PostgreSQL adds a required business
-- column to a table that already contains rows.
-- ---------------------------------------------------------------------------

alter table if exists public.user_profiles
  add column if not exists user_id uuid,
  add column if not exists display_name text,
  add column if not exists avatar_url text,
  add column if not exists locale text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table if exists public.entitlements
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists plan_code text default 'legacy',
  add column if not exists plan_name text default 'Legacy entitlement',
  add column if not exists status text default 'active',
  add column if not exists unlimited boolean default false,
  add column if not exists starts_at timestamptz default now(),
  add column if not exists ends_at timestamptz,
  add column if not exists source text default 'migration',
  add column if not exists source_reference text,
  add column if not exists metadata jsonb default '{}'::jsonb,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table if exists public.purchases
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists provider text default 'dodo',
  add column if not exists provider_payment_id text,
  add column if not exists provider_customer_id text,
  add column if not exists product_code text default 'legacy',
  add column if not exists amount_minor bigint,
  add column if not exists currency text,
  add column if not exists status text default 'pending',
  add column if not exists purchased_at timestamptz,
  add column if not exists metadata jsonb default '{}'::jsonb,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table if exists public.session_allocations
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists entitlement_id uuid,
  add column if not exists purchase_id uuid,
  add column if not exists kind text default 'trial',
  add column if not exists status text default 'available',
  add column if not exists allocated_seconds integer default 0,
  add column if not exists consumed_seconds integer default 0,
  add column if not exists reserved_at timestamptz,
  add column if not exists activated_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table if exists public.business_sessions
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists allocation_id uuid,
  add column if not exists status text default 'pending',
  add column if not exists client_session_id uuid default gen_random_uuid(),
  add column if not exists started_at timestamptz,
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists consumed_seconds integer default 0,
  add column if not exists failure_code text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

alter table if exists public.usage_sessions
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists business_session_id uuid,
  add column if not exists sequence_no integer default 0,
  add column if not exists active_seconds integer default 0,
  add column if not exists observed_at timestamptz default now(),
  add column if not exists created_at timestamptz default now();

alter table if exists public.webhook_events
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists provider text default 'dodo',
  add column if not exists provider_event_id text,
  add column if not exists event_type text default 'unknown',
  add column if not exists status text default 'received',
  add column if not exists payload_sha256 text,
  add column if not exists error_code text,
  add column if not exists attempts integer default 0,
  add column if not exists received_at timestamptz default now(),
  add column if not exists processed_at timestamptz;

alter table if exists public.review_prompt_state
  add column if not exists user_id uuid,
  add column if not exists has_reviewed boolean default false,
  add column if not exists dismissed_count integer default 0,
  add column if not exists dont_show_again boolean default false,
  add column if not exists last_prompted_at timestamptz,
  add column if not exists next_eligible_at timestamptz,
  add column if not exists updated_at timestamptz default now();

alter table if exists public.reviews
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists user_id uuid,
  add column if not exists rating smallint,
  add column if not exists review_text text,
  add column if not exists can_use_publicly boolean default false,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

-- Keep the payment ledger when an account is deleted, but remove its direct
-- link to the deleted auth identity. If legacy rows violate the relationship,
-- PostgreSQL rolls this block back and prints a warning instead of losing data.
alter table if exists public.purchases alter column user_id drop not null;
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'purchases'
      and con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and con.conkey = array[(
        select attnum
        from pg_attribute
        where attrelid = rel.oid
          and attname = 'user_id'
          and not attisdropped
      )]
  loop
    execute format('alter table public.purchases drop constraint %I', constraint_name);
  end loop;

  alter table public.purchases
    add constraint purchases_user_id_hintily_fkey
    foreign key (user_id) references auth.users(id) on delete set null;
exception
  when foreign_key_violation then
    raise warning 'Some purchases reference missing auth users; the existing purchases user foreign key was preserved.';
  when duplicate_object then
    raise warning 'A purchases_user_id_hintily_fkey constraint already exists; its current definition was preserved.';
end;
$$;

-- Normalize nullable defaults without changing meaningful existing values.
update public.entitlements set
  id = coalesce(id, gen_random_uuid()),
  plan_code = coalesce(plan_code, 'legacy'),
  plan_name = coalesce(plan_name, 'Legacy entitlement'),
  status = coalesce(status, 'active'),
  unlimited = coalesce(unlimited, false),
  starts_at = coalesce(starts_at, created_at, now()),
  source = coalesce(source, 'migration'),
  metadata = coalesce(metadata, '{}'::jsonb),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, created_at, now());

update public.purchases set
  id = coalesce(id, gen_random_uuid()),
  provider = coalesce(provider, 'dodo'),
  product_code = coalesce(product_code, 'legacy'),
  status = coalesce(status, 'pending'),
  metadata = coalesce(metadata, '{}'::jsonb),
  created_at = coalesce(created_at, purchased_at, now()),
  updated_at = coalesce(updated_at, created_at, now());

update public.session_allocations set
  id = coalesce(id, gen_random_uuid()),
  kind = coalesce(kind, 'trial'),
  status = coalesce(status, 'available'),
  allocated_seconds = coalesce(allocated_seconds, 0),
  consumed_seconds = coalesce(consumed_seconds, 0),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, created_at, now());

update public.business_sessions set
  id = coalesce(id, gen_random_uuid()),
  status = coalesce(status, 'pending'),
  client_session_id = coalesce(client_session_id, gen_random_uuid()),
  consumed_seconds = coalesce(consumed_seconds, 0),
  created_at = coalesce(created_at, started_at, now()),
  updated_at = coalesce(updated_at, created_at, now());

update public.usage_sessions set
  id = coalesce(id, gen_random_uuid()),
  sequence_no = coalesce(sequence_no, 0),
  active_seconds = coalesce(active_seconds, 0),
  observed_at = coalesce(observed_at, created_at, now()),
  created_at = coalesce(created_at, observed_at, now());

update public.webhook_events set
  id = coalesce(id, gen_random_uuid()),
  provider = coalesce(provider, 'dodo'),
  event_type = coalesce(event_type, 'unknown'),
  status = coalesce(status, 'received'),
  attempts = coalesce(attempts, 0),
  received_at = coalesce(received_at, now());

update public.review_prompt_state set
  has_reviewed = coalesce(has_reviewed, false),
  dismissed_count = coalesce(dismissed_count, 0),
  dont_show_again = coalesce(dont_show_again, false),
  updated_at = coalesce(updated_at, now());

update public.reviews set
  id = coalesce(id, gen_random_uuid()),
  can_use_publicly = coalesce(can_use_publicly, false),
  created_at = coalesce(created_at, now()),
  updated_at = coalesce(updated_at, created_at, now());

-- ---------------------------------------------------------------------------
-- Indexes. Non-unique lookup indexes are always safe to create.
-- Unique indexes are attempted without deleting duplicates; if legacy duplicate
-- rows exist, the migration continues and reports a warning for manual cleanup.
-- ---------------------------------------------------------------------------

create index if not exists entitlements_user_status_idx
  on public.entitlements(user_id, status);
create index if not exists purchases_user_idx
  on public.purchases(user_id, created_at desc);
create index if not exists session_allocations_user_status_idx
  on public.session_allocations(user_id, status, created_at);
create index if not exists business_sessions_user_idx
  on public.business_sessions(user_id, created_at desc);
create index if not exists usage_sessions_user_idx
  on public.usage_sessions(user_id, created_at desc);
create index if not exists reviews_user_idx
  on public.reviews(user_id, created_at desc);

do $$
begin
  begin
    create unique index if not exists entitlements_source_unique
      on public.entitlements(source, source_reference)
      where source_reference is not null;
  exception when unique_violation then
    raise warning 'Duplicate entitlement source references exist; entitlements_source_unique was not created.';
  end;

  begin
    create unique index if not exists purchases_provider_payment_unique
      on public.purchases(provider, provider_payment_id)
      where provider_payment_id is not null;
  exception when unique_violation then
    raise warning 'Duplicate provider payment IDs exist; purchases_provider_payment_unique was not created.';
  end;

  begin
    create unique index if not exists business_sessions_user_client_unique
      on public.business_sessions(user_id, client_session_id)
      where user_id is not null and client_session_id is not null;
  exception when unique_violation then
    raise warning 'Duplicate client session IDs exist; business_sessions_user_client_unique was not created.';
  end;

  begin
    create unique index if not exists usage_sessions_business_sequence_unique
      on public.usage_sessions(business_session_id, sequence_no)
      where business_session_id is not null;
  exception when unique_violation then
    raise warning 'Duplicate usage sequence numbers exist; usage_sessions_business_sequence_unique was not created.';
  end;

  begin
    create unique index if not exists webhook_events_provider_event_unique
      on public.webhook_events(provider, provider_event_id)
      where provider_event_id is not null;
  exception when unique_violation then
    raise warning 'Duplicate webhook event IDs exist; webhook_events_provider_event_unique was not created.';
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- updated_at triggers.
-- ---------------------------------------------------------------------------

drop trigger if exists user_profiles_updated_at on public.user_profiles;
create trigger user_profiles_updated_at before update on public.user_profiles
for each row execute function public.set_updated_at();

drop trigger if exists entitlements_updated_at on public.entitlements;
create trigger entitlements_updated_at before update on public.entitlements
for each row execute function public.set_updated_at();

drop trigger if exists purchases_updated_at on public.purchases;
create trigger purchases_updated_at before update on public.purchases
for each row execute function public.set_updated_at();

drop trigger if exists session_allocations_updated_at on public.session_allocations;
create trigger session_allocations_updated_at before update on public.session_allocations
for each row execute function public.set_updated_at();

drop trigger if exists business_sessions_updated_at on public.business_sessions;
create trigger business_sessions_updated_at before update on public.business_sessions
for each row execute function public.set_updated_at();

drop trigger if exists review_prompt_state_updated_at on public.review_prompt_state;
create trigger review_prompt_state_updated_at before update on public.review_prompt_state
for each row execute function public.set_updated_at();

drop trigger if exists reviews_updated_at on public.reviews;
create trigger reviews_updated_at before update on public.reviews
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Google OAuth profile creation and existing-user backfill.
-- ---------------------------------------------------------------------------

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
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
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_hintily on auth.users;
create trigger on_auth_user_created_hintily
after insert on auth.users
for each row execute function public.create_profile_for_new_user();

insert into public.user_profiles(user_id, display_name, avatar_url)
select
  users.id,
  left(coalesce(users.raw_user_meta_data ->> 'full_name', users.raw_user_meta_data ->> 'name'), 120),
  left(coalesce(users.raw_user_meta_data ->> 'avatar_url', users.raw_user_meta_data ->> 'picture'), 2048)
from auth.users as users
where not exists (
  select 1 from public.user_profiles profiles where profiles.user_id = users.id
);

-- ---------------------------------------------------------------------------
-- Row-level security. Users may read only their own business records.
-- Financial, allocation, session, usage, and webhook writes remain server-only.
-- ---------------------------------------------------------------------------

alter table public.user_profiles enable row level security;
alter table public.entitlements enable row level security;
alter table public.purchases enable row level security;
alter table public.session_allocations enable row level security;
alter table public.business_sessions enable row level security;
alter table public.usage_sessions enable row level security;
alter table public.webhook_events enable row level security;
alter table public.review_prompt_state enable row level security;
alter table public.reviews enable row level security;

drop policy if exists "profiles_select_own" on public.user_profiles;
drop policy if exists "profiles_update_own" on public.user_profiles;
drop policy if exists "entitlements_select_own" on public.entitlements;
drop policy if exists "purchases_select_own" on public.purchases;
drop policy if exists "allocations_select_own" on public.session_allocations;
drop policy if exists "business_sessions_select_own" on public.business_sessions;
drop policy if exists "usage_sessions_select_own" on public.usage_sessions;
drop policy if exists "review_state_select_own" on public.review_prompt_state;
drop policy if exists "review_state_insert_own" on public.review_prompt_state;
drop policy if exists "review_state_update_own" on public.review_prompt_state;
drop policy if exists "reviews_select_own" on public.reviews;
drop policy if exists "reviews_insert_own" on public.reviews;
drop policy if exists "reviews_update_own" on public.reviews;

create policy "profiles_select_own"
  on public.user_profiles for select
  using ((select auth.uid()) = user_id);
create policy "profiles_update_own"
  on public.user_profiles for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "entitlements_select_own"
  on public.entitlements for select
  using ((select auth.uid()) = user_id);
create policy "purchases_select_own"
  on public.purchases for select
  using ((select auth.uid()) = user_id);
create policy "allocations_select_own"
  on public.session_allocations for select
  using ((select auth.uid()) = user_id);
create policy "business_sessions_select_own"
  on public.business_sessions for select
  using ((select auth.uid()) = user_id);
create policy "usage_sessions_select_own"
  on public.usage_sessions for select
  using ((select auth.uid()) = user_id);
create policy "review_state_select_own"
  on public.review_prompt_state for select
  using ((select auth.uid()) = user_id);
create policy "review_state_insert_own"
  on public.review_prompt_state for insert
  with check ((select auth.uid()) = user_id);
create policy "review_state_update_own"
  on public.review_prompt_state for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "reviews_select_own"
  on public.reviews for select
  using ((select auth.uid()) = user_id);
create policy "reviews_insert_own"
  on public.reviews for insert
  with check ((select auth.uid()) = user_id);
create policy "reviews_update_own"
  on public.reviews for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on public.webhook_events from anon, authenticated;
revoke insert, update, delete
  on public.entitlements,
     public.purchases,
     public.session_allocations,
     public.business_sessions,
     public.usage_sessions
  from anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verification result (read-only): this final query should return zero rows.
-- ---------------------------------------------------------------------------

with expected(table_name, column_name) as (
  values
    ('user_profiles', 'user_id'),
    ('user_profiles', 'display_name'),
    ('user_profiles', 'avatar_url'),
    ('user_profiles', 'locale'),
    ('entitlements', 'id'),
    ('entitlements', 'user_id'),
    ('entitlements', 'plan_code'),
    ('entitlements', 'plan_name'),
    ('entitlements', 'status'),
    ('entitlements', 'unlimited'),
    ('entitlements', 'starts_at'),
    ('entitlements', 'ends_at'),
    ('entitlements', 'source'),
    ('entitlements', 'source_reference'),
    ('entitlements', 'metadata'),
    ('purchases', 'id'),
    ('purchases', 'user_id'),
    ('purchases', 'provider'),
    ('purchases', 'provider_payment_id'),
    ('purchases', 'provider_customer_id'),
    ('purchases', 'product_code'),
    ('purchases', 'amount_minor'),
    ('purchases', 'currency'),
    ('purchases', 'status'),
    ('purchases', 'purchased_at'),
    ('session_allocations', 'id'),
    ('session_allocations', 'user_id'),
    ('session_allocations', 'entitlement_id'),
    ('session_allocations', 'purchase_id'),
    ('session_allocations', 'kind'),
    ('session_allocations', 'status'),
    ('session_allocations', 'allocated_seconds'),
    ('session_allocations', 'consumed_seconds'),
    ('business_sessions', 'id'),
    ('business_sessions', 'user_id'),
    ('business_sessions', 'allocation_id'),
    ('business_sessions', 'client_session_id'),
    ('business_sessions', 'status'),
    ('usage_sessions', 'id'),
    ('usage_sessions', 'user_id'),
    ('usage_sessions', 'business_session_id'),
    ('usage_sessions', 'sequence_no'),
    ('usage_sessions', 'active_seconds'),
    ('webhook_events', 'id'),
    ('webhook_events', 'provider'),
    ('webhook_events', 'provider_event_id'),
    ('webhook_events', 'event_type'),
    ('webhook_events', 'status'),
    ('review_prompt_state', 'user_id'),
    ('review_prompt_state', 'has_reviewed'),
    ('reviews', 'id'),
    ('reviews', 'user_id'),
    ('reviews', 'rating')
)
select expected.table_name, expected.column_name
from expected
left join information_schema.columns columns
  on columns.table_schema = 'public'
 and columns.table_name = expected.table_name
 and columns.column_name = expected.column_name
where columns.column_name is null
order by expected.table_name, expected.column_name;
