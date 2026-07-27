begin;

alter table if exists public.purchases
  add column if not exists provider_event_at timestamptz;
alter table if exists public.entitlements
  add column if not exists provider_event_at timestamptz;

create table if not exists public.provider_event_cutovers (
  provider text primary key,
  enforced_at timestamptz not null
);
alter table public.provider_event_cutovers enable row level security;
revoke all on public.provider_event_cutovers from public, anon, authenticated;
insert into public.provider_event_cutovers(provider, enforced_at)
values ('dodo', now())
on conflict (provider) do nothing;

create or replace function public.hintily_apply_dodo_event(
  event_id text,
  event_type text,
  event_occurred_at timestamptz,
  event_payload_sha256 text,
  target_user_id uuid,
  payment_id text,
  customer_id text,
  subscription_id text,
  product_code text,
  session_count integer,
  unlimited_plan boolean,
  entitlement_ends_at timestamptz,
  amount_minor bigint,
  currency_code text,
  safe_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  webhook_row uuid;
  purchase_row uuid;
  entitlement_row uuid;
  ordering_cutover timestamptz;
  i integer;
  grants_access boolean := event_type in (
    'payment.succeeded', 'payment.success', 'subscription.active', 'subscription.renewed'
  );
  restores_access boolean := event_type in ('dispute.won', 'dispute.cancelled');
  terminal boolean := event_type in (
    'payment.failed', 'payment.cancelled', 'subscription.cancelled',
    'subscription.expired', 'subscription.failed', 'subscription.on_hold', 'refund.succeeded',
    'dispute.opened', 'dispute.accepted', 'dispute.lost'
  );
begin
  if event_id is null or length(event_id) > 200 then raise exception 'invalid_event_id'; end if;
  if event_occurred_at is null then raise exception 'invalid_event_timestamp'; end if;
  insert into public.webhook_events(
    provider, provider_event_id, event_type, status, payload_sha256, attempts
  ) values ('dodo', event_id, left(event_type, 120), 'processing', event_payload_sha256, 1)
  on conflict (provider, provider_event_id)
    where provider_event_id is not null
  do update
    set status = 'processing',
        processed_at = null,
        error_code = null,
        attempts = public.webhook_events.attempts + 1
    where public.webhook_events.status = 'received'
      and public.webhook_events.error_code = 'provider_reconciliation_required'
  returning id into webhook_row;
  if webhook_row is null then return jsonb_build_object('duplicate', true); end if;

  if target_user_id is null or product_code is null then
    update public.webhook_events set status = 'ignored', processed_at = now(),
      error_code = 'unmapped_customer_or_product' where id = webhook_row;
    return jsonb_build_object('ignored', true);
  end if;

  if not terminal and not restores_access and not grants_access then
    update public.webhook_events set status = 'ignored', processed_at = now(),
      error_code = 'non_entitling_event' where id = webhook_row;
    return jsonb_build_object('ignored', true);
  end if;

  select enforced_at into ordering_cutover
  from public.provider_event_cutovers
  where provider = 'dodo';
  if event_occurred_at < ordering_cutover and (
    exists (
      select 1 from public.entitlements e
      where e.user_id = target_user_id and e.source = 'dodo'
        and e.source_reference in (subscription_id, payment_id)
        and e.provider_event_at is null
    )
    or exists (
      select 1 from public.purchases p
      where p.user_id = target_user_id and p.provider = 'dodo'
        and p.provider_payment_id = payment_id
        and p.provider_event_at is null
    )
  ) then
    update public.webhook_events set status = 'received', processed_at = null,
      error_code = 'provider_reconciliation_required' where id = webhook_row;
    return jsonb_build_object(
      'ignored', true, 'reconciliation_required', true
    );
  end if;

  if exists (
    select 1
    from public.entitlements e
    where e.user_id = target_user_id
      and e.source = 'dodo'
      and e.source_reference in (subscription_id, payment_id)
      and e.provider_event_at > event_occurred_at
  ) then
    update public.webhook_events set status = 'ignored', processed_at = now(),
      error_code = 'stale_provider_event' where id = webhook_row;
    return jsonb_build_object('ignored', true, 'stale', true);
  end if;

  insert into public.purchases(
    user_id, provider, provider_payment_id, provider_customer_id, product_code,
    amount_minor, currency, status, purchased_at, metadata, provider_event_at
  ) values (
    target_user_id, 'dodo', coalesce(payment_id, event_id), customer_id, product_code,
    amount_minor, nullif(upper(currency_code), ''),
    case when restores_access then 'paid'
    when terminal then
      case when event_type = 'refund.succeeded' then 'refunded'
           when event_type like 'dispute.%' then 'disputed' else 'failed' end
    when grants_access then 'paid' else 'pending' end,
    case when grants_access then now() else null end,
    coalesce(safe_metadata, '{}'::jsonb), event_occurred_at
  )
  on conflict (provider, provider_payment_id)
    where provider_payment_id is not null do update set
    status = excluded.status, provider_customer_id = coalesce(excluded.provider_customer_id, public.purchases.provider_customer_id),
    metadata = public.purchases.metadata || excluded.metadata,
    provider_event_at = excluded.provider_event_at, updated_at = now()
    where public.purchases.provider_event_at is null
       or public.purchases.provider_event_at <= excluded.provider_event_at
  returning id into purchase_row;
  if purchase_row is null then
    update public.webhook_events set status = 'ignored', processed_at = now(),
      error_code = 'stale_provider_event' where id = webhook_row;
    return jsonb_build_object('ignored', true, 'stale', true);
  end if;

  if terminal then
    update public.business_sessions s
    set status = 'failed', failure_code = 'payment_access_revoked',
      completed_at = coalesce(s.completed_at, now()), updated_at = now()
    where s.user_id = target_user_id
      and s.status in ('pending', 'active', 'paused')
      and exists (
        select 1
        from public.session_allocations a
        where a.id = s.allocation_id
          and a.purchase_id = purchase_row
          and a.consumed_seconds < a.allocated_seconds
      );
    update public.session_allocations set status = 'revoked', updated_at = now()
    where purchase_id = purchase_row
      and consumed_seconds < allocated_seconds
      and status in ('available', 'reserved', 'active');
    update public.entitlements set
      status = case
        when event_type in ('payment.failed', 'subscription.failed', 'subscription.on_hold') then 'past_due'
        when event_type = 'subscription.cancelled' then 'cancelled'
        when event_type = 'subscription.expired' then 'expired'
        else 'revoked' end,
      provider_event_at = event_occurred_at,
      updated_at = now()
    where user_id = target_user_id and source = 'dodo'
      and source_reference in (subscription_id, payment_id)
      and (provider_event_at is null or provider_event_at <= event_occurred_at);
    update public.business_sessions s
    set status = 'failed', failure_code = 'payment_access_revoked',
      completed_at = coalesce(s.completed_at, now()), updated_at = now()
    where s.user_id = target_user_id
      and s.allocation_id is null
      and s.status in ('pending', 'active', 'paused')
      and not exists (
        select 1
        from public.entitlements e
        where e.user_id = target_user_id
          and e.unlimited
          and e.status in ('trial', 'active')
          and e.starts_at <= now()
          and (e.ends_at is null or e.ends_at > now())
      );
  elsif restores_access then
    update public.session_allocations
    set status = 'available', reserved_at = null, updated_at = now()
    where purchase_id = purchase_row
      and status = 'revoked'
      and consumed_seconds < allocated_seconds
      and (expires_at is null or expires_at > now());
    update public.entitlements
    set status = 'active', provider_event_at = event_occurred_at, updated_at = now()
    where user_id = target_user_id and source = 'dodo'
      and source_reference in (subscription_id, payment_id)
      and (provider_event_at is null or provider_event_at <= event_occurred_at)
      and (ends_at is null or ends_at > now());
  elsif unlimited_plan then
    insert into public.entitlements(
      user_id, plan_code, plan_name, status, unlimited, starts_at, ends_at,
      source, source_reference, metadata, provider_event_at
    ) values (
      target_user_id, product_code, product_code, 'active', true, now(),
      entitlement_ends_at, 'dodo', coalesce(subscription_id, payment_id),
      coalesce(safe_metadata, '{}'::jsonb), event_occurred_at
    )
    on conflict (source, source_reference) where source_reference is not null
    do update set status = 'active', unlimited = true,
      ends_at = greatest(public.entitlements.ends_at, excluded.ends_at),
      metadata = public.entitlements.metadata || excluded.metadata,
      provider_event_at = event_occurred_at, updated_at = now()
    where public.entitlements.provider_event_at is null
       or public.entitlements.provider_event_at <= event_occurred_at;
  elsif session_count > 0 then
    insert into public.entitlements(
      user_id, plan_code, plan_name, status, unlimited, source, source_reference,
      metadata, provider_event_at
    ) values (
      target_user_id, product_code, product_code, 'active', false,
      'dodo', coalesce(payment_id, event_id), coalesce(safe_metadata, '{}'::jsonb),
      event_occurred_at
    )
    on conflict (source, source_reference) where source_reference is not null
    do update set provider_event_at = event_occurred_at, updated_at = now()
    where public.entitlements.provider_event_at is null
       or public.entitlements.provider_event_at <= event_occurred_at
    returning id into entitlement_row;

    if entitlement_row is null then
      update public.webhook_events set status = 'ignored', processed_at = now(),
        error_code = 'stale_provider_event' where id = webhook_row;
      return jsonb_build_object('ignored', true, 'stale', true);
    end if;

    for i in 1..session_count loop
      insert into public.session_allocations(
        user_id, entitlement_id, purchase_id, kind, status, allocated_seconds, consumed_seconds
      )
      select target_user_id, entitlement_row, purchase_row, 'paid', 'available', 3600, 0
      where not exists (
        select 1 from public.session_allocations
        where purchase_id = purchase_row and kind = 'paid'
        offset i - 1 limit 1
      );
    end loop;
  end if;

  update public.webhook_events set status = 'processed', processed_at = now()
  where id = webhook_row;
  return jsonb_build_object('processed', true, 'purchase_id', purchase_row);
exception when others then
  update public.webhook_events set status = 'failed',
    error_code = left(sqlstate, 80), attempts = attempts + 1 where id = webhook_row;
  raise;
end;
$$;

drop function if exists public.hintily_apply_dodo_event(
  text, text, text, uuid, text, text, text, text, integer, boolean,
  timestamptz, bigint, text, jsonb
);

revoke all on function public.hintily_apply_dodo_event(
  text, text, timestamptz, text, uuid, text, text, text, text, integer, boolean,
  timestamptz, bigint, text, jsonb
) from public, anon, authenticated;
grant execute on function public.hintily_apply_dodo_event(
  text, text, timestamptz, text, uuid, text, text, text, text, integer, boolean,
  timestamptz, bigint, text, jsonb
) to service_role;

commit;
