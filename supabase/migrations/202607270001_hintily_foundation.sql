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

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (char_length(display_name) <= 120),
  avatar_url text check (char_length(avatar_url) <= 2048),
  locale text check (char_length(locale) <= 20),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_code text not null,
  plan_name text not null,
  status text not null check (status in ('trial', 'active', 'past_due', 'cancelled', 'expired', 'revoked')),
  unlimited boolean not null default false,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  source text not null check (source in ('free_trial', 'dodo', 'support', 'migration')),
  source_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);

create unique index if not exists entitlements_source_unique
  on public.entitlements(source, source_reference)
  where source_reference is not null;
create index if not exists entitlements_user_status_idx on public.entitlements(user_id, status);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  -- Keep the immutable payment ledger after an account is deleted, without
  -- retaining a foreign-key link to the deleted identity.
  user_id uuid references auth.users(id) on delete set null,
  provider text not null default 'dodo' check (provider in ('dodo')),
  provider_payment_id text not null,
  provider_customer_id text,
  product_code text not null,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('pending', 'paid', 'refunded', 'partially_refunded', 'disputed', 'failed')),
  purchased_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_payment_id)
);

-- Reconcile an earlier Hintily schema where purchases.user_id was NOT NULL
-- with ON DELETE RESTRICT. Account deletion must remove the identity while the
-- legally relevant payment ledger remains pseudonymised.
alter table public.purchases alter column user_id drop not null;
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
end;
$$;
alter table public.purchases
  add constraint purchases_user_id_hintily_fkey
  foreign key (user_id) references auth.users(id) on delete set null;

create index if not exists purchases_user_idx on public.purchases(user_id, created_at desc);

create table if not exists public.session_allocations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entitlement_id uuid references public.entitlements(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete restrict,
  kind text not null check (kind in ('trial', 'paid', 'support')),
  status text not null default 'available' check (status in ('available', 'reserved', 'active', 'consumed', 'expired', 'revoked')),
  allocated_seconds integer not null check (allocated_seconds > 0),
  consumed_seconds integer not null default 0 check (consumed_seconds >= 0),
  reserved_at timestamptz,
  activated_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (consumed_seconds <= allocated_seconds)
);
create index if not exists session_allocations_user_status_idx
  on public.session_allocations(user_id, status, created_at);

create table if not exists public.business_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  allocation_id uuid references public.session_allocations(id) on delete restrict,
  status text not null check (status in ('pending', 'active', 'paused', 'completed', 'failed', 'abandoned')),
  client_session_id uuid not null,
  started_at timestamptz,
  last_heartbeat_at timestamptz,
  completed_at timestamptz,
  consumed_seconds integer not null default 0 check (consumed_seconds >= 0),
  failure_code text check (char_length(failure_code) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_session_id)
);
create index if not exists business_sessions_user_idx on public.business_sessions(user_id, created_at desc);

create table if not exists public.usage_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_session_id uuid not null references public.business_sessions(id) on delete cascade,
  sequence_no integer not null check (sequence_no >= 0),
  active_seconds integer not null check (active_seconds >= 0 and active_seconds <= 300),
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (business_session_id, sequence_no)
);
create index if not exists usage_sessions_user_idx on public.usage_sessions(user_id, created_at desc);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('dodo')),
  provider_event_id text not null,
  event_type text not null,
  status text not null default 'received' check (status in ('received', 'processing', 'processed', 'failed', 'ignored')),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  error_code text,
  attempts integer not null default 0 check (attempts >= 0),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);

create table if not exists public.review_prompt_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  has_reviewed boolean not null default false,
  dismissed_count integer not null default 0 check (dismissed_count >= 0),
  dont_show_again boolean not null default false,
  last_prompted_at timestamptz,
  next_eligible_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  review_text text check (char_length(review_text) <= 5000),
  can_use_publicly boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists reviews_user_idx on public.reviews(user_id, created_at desc);

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

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles(user_id, display_name, avatar_url)
  values (
    new.id,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), 120),
    left(coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture'), 2048)
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_hintily on auth.users;
create trigger on_auth_user_created_hintily
after insert on auth.users
for each row execute function public.create_profile_for_new_user();

-- The trigger above covers only users created after this migration. Backfill
-- existing Google/Supabase users so every authenticated account has the same
-- profile invariant. ON CONFLICT makes this safe to replay without replacing
-- profile edits that may already exist.
insert into public.user_profiles(user_id, display_name, avatar_url)
select
  users.id,
  left(coalesce(users.raw_user_meta_data ->> 'full_name', users.raw_user_meta_data ->> 'name'), 120),
  left(coalesce(users.raw_user_meta_data ->> 'avatar_url', users.raw_user_meta_data ->> 'picture'), 2048)
from auth.users as users
on conflict (user_id) do nothing;

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

create policy "profiles_select_own" on public.user_profiles for select using ((select auth.uid()) = user_id);
create policy "profiles_update_own" on public.user_profiles for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "entitlements_select_own" on public.entitlements for select using ((select auth.uid()) = user_id);
create policy "purchases_select_own" on public.purchases for select using ((select auth.uid()) = user_id);
create policy "allocations_select_own" on public.session_allocations for select using ((select auth.uid()) = user_id);
create policy "business_sessions_select_own" on public.business_sessions for select using ((select auth.uid()) = user_id);
create policy "usage_sessions_select_own" on public.usage_sessions for select using ((select auth.uid()) = user_id);
create policy "review_state_select_own" on public.review_prompt_state for select using ((select auth.uid()) = user_id);
create policy "review_state_insert_own" on public.review_prompt_state for insert with check ((select auth.uid()) = user_id);
create policy "review_state_update_own" on public.review_prompt_state for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "reviews_select_own" on public.reviews for select using ((select auth.uid()) = user_id);
create policy "reviews_insert_own" on public.reviews for insert with check ((select auth.uid()) = user_id);
create policy "reviews_update_own" on public.reviews for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

revoke all on public.webhook_events from anon, authenticated;
revoke insert, update, delete on public.entitlements, public.purchases, public.session_allocations, public.business_sessions, public.usage_sessions from anon, authenticated;

commit;
