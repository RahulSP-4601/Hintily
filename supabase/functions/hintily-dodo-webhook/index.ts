import { productMap, sha256, verifyDodoSignature } from '../_shared/dodo.ts';
import { adminClient, json } from '../_shared/http.ts';

const value = (object: Record<string, unknown>, ...names: string[]) => {
  for (const name of names) if (object[name] != null) return object[name];
  return null;
};

const addUtcMonths = (source: Date, months: number) => {
  const day = source.getUTCDate();
  const result = new Date(Date.UTC(
    source.getUTCFullYear(), source.getUTCMonth() + months, 1,
    source.getUTCHours(), source.getUTCMinutes(), source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  ));
  const lastDay = new Date(Date.UTC(
    result.getUTCFullYear(), result.getUTCMonth() + 1, 0,
  )).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result.toISOString();
};

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const raw = await request.text();
  if (raw.length > 1_000_000) return json(413, { error: 'payload_too_large' });
  const id = request.headers.get('webhook-id') || '';
  const timestamp = request.headers.get('webhook-timestamp') || '';
  const signature = request.headers.get('webhook-signature') || '';
  const secret = Deno.env.get('DODO_PAYMENTS_WEBHOOK_KEY') || '';
  if (!secret || !(await verifyDodoSignature(raw, id, timestamp, signature, secret))) {
    return json(401, { error: 'invalid_signature' });
  }
  try {
    const event = JSON.parse(raw) as Record<string, unknown>;
    const envelope = (event.data && typeof event.data === 'object' ? event.data : {}) as Record<string, unknown>;
    const data = (envelope.object && typeof envelope.object === 'object'
      ? envelope.object : envelope) as Record<string, unknown>;
    const metadata = (data.metadata && typeof data.metadata === 'object' ? data.metadata : {}) as Record<string, unknown>;
    const eventType = String(event.type || '');
    const eventTimestamp = typeof event.timestamp === 'string' ? event.timestamp : '';
    if (!eventTimestamp || !Number.isFinite(Date.parse(eventTimestamp))) {
      return json(400, { error: 'invalid_event_timestamp' });
    }
    let code = String(metadata.hintily_product_code || '');
    let userId = String(metadata.hintily_user_id || '');
    const paymentId = String(value(data, 'payment_id', 'id') || '');
    let subscriptionId = String(value(data, 'subscription_id') || '');
    const admin = adminClient();
    if ((!code || !userId || !subscriptionId) && paymentId) {
      const { data: existing } = await admin.from('purchases')
        .select('user_id,product_code,metadata').eq('provider', 'dodo')
        .eq('provider_payment_id', paymentId).maybeSingle();
      code ||= String(existing?.product_code || '');
      userId ||= String(existing?.user_id || '');
      const storedMetadata = existing?.metadata && typeof existing.metadata === 'object'
        && !Array.isArray(existing.metadata)
        ? existing.metadata as Record<string, unknown>
        : {};
      const storedSubscriptionId = storedMetadata.dodo_subscription_id;
      if (!subscriptionId && typeof storedSubscriptionId === 'string') {
        subscriptionId = storedSubscriptionId;
      }
    }
    if ((!code || !userId) && subscriptionId) {
      const { data: existing } = await admin.from('entitlements')
        .select('user_id,plan_code').eq('source', 'dodo')
        .eq('source_reference', subscriptionId).maybeSingle();
      code ||= String(existing?.plan_code || '');
      userId ||= String(existing?.user_id || '');
    }
    const product = productMap()[code];
    const subscriptionLifecycle =
      /^(subscription\.(active|renewed))$/.test(eventType);
    const rawReceivedAmount = subscriptionLifecycle
      ? value(data, 'recurring_pre_tax_amount', 'recurring_amount')
      : value(data, 'total_amount', 'amount');
    const receivedAmount = rawReceivedAmount == null ? Number.NaN : Number(rawReceivedAmount);
    const receivedCurrency = String(value(data, 'currency') || '').toUpperCase();
    let appliedEventTimestamp = eventTimestamp;
    const grantsAccess = /^(payment\.(succeeded|success)|subscription\.(active|renewed))$/.test(eventType);
    if (grantsAccess && product && (
      !Number.isSafeInteger(receivedAmount)
      || receivedAmount !== product.amountMinor
      || receivedCurrency !== 'INR'
    )) {
      return json(400, { error: 'payment_amount_mismatch' });
    }
    let endsAt = value(data, 'next_billing_date', 'expires_at');
    if (product?.unlimited && product.interval !== 'lifetime' && typeof endsAt !== 'string') {
      const periodStart = new Date(eventTimestamp);
      endsAt = addUtcMonths(
        periodStart,
        product.interval === 'year' ? 12 : product.interval === 'quarter' ? 3 : 1,
      );
    }
    if (product?.interval === 'lifetime') endsAt = null;

    if (eventType === 'refund.succeeded') {
      if (!paymentId) return json(400, { error: 'refund_payment_id_required' });
      const refundedRaw = value(data, 'refunded_amount', 'refund_amount', 'amount');
      const refundedAmount = refundedRaw == null ? Number.NaN : Number(refundedRaw);
      if (!Number.isSafeInteger(refundedAmount) || refundedAmount <= 0) {
        return json(400, { error: 'invalid_refund_amount' });
      }
      const { data: originalPurchase, error: originalPurchaseError } = await admin.from('purchases')
        .select('amount_minor').eq('provider', 'dodo')
        .eq('provider_payment_id', paymentId).maybeSingle();
      if (originalPurchaseError) {
        return json(500, { error: 'webhook_processing_failed' });
      }
      const originalAmount = Number(originalPurchase?.amount_minor);
      // Never guess that an unmatched or malformed refund is a full refund.
      // A retry can reconcile delivery ordering once the purchase exists;
      // falling through here would revoke every allocation for the payment.
      if (!Number.isSafeInteger(originalAmount) || originalAmount <= 0) {
        return json(500, { error: 'purchase_reconciliation_required' });
      }
      if (refundedAmount < originalAmount) {
        const { data: partial, error: partialError } = await admin.rpc(
          'hintily_apply_dodo_partial_refund',
          {
            event_id: id,
            event_occurred_at: eventTimestamp,
            event_payload_sha256: await sha256(raw),
            payment_id: paymentId,
            refund_delta_minor: refundedAmount,
            safe_metadata: {
              dodo_event_type: eventType,
              dodo_subscription_id: subscriptionId || null,
            },
          },
        );
        if (partialError) {
          await admin.rpc('hintily_record_dodo_webhook_failure', {
            event_id: id,
            event_type: 'refund.partial',
            event_payload_sha256: await sha256(raw),
            safe_error_code: 'partial_refund_processing_failed',
          });
          return json(500, { error: 'webhook_processing_failed' });
        }
        const partialResult = partial as {
          full_refund?: boolean;
          effective_event_at?: string;
        } | null;
        if (!partialResult?.full_refund) {
          return json(200, partial);
        }
        if (partialResult.effective_event_at
          && Number.isFinite(Date.parse(partialResult.effective_event_at))) {
          appliedEventTimestamp = partialResult.effective_event_at;
        }
      }
    }
    const terminal = /^(payment\.(failed|cancelled)|subscription\.(cancelled|expired|failed|on_hold)|refund\.succeeded|dispute\.)/.test(eventType);
    const { data: applied, error } = await admin.rpc('hintily_apply_dodo_event', {
      event_id: id,
      event_type: eventType,
      event_occurred_at: appliedEventTimestamp,
      event_payload_sha256: await sha256(raw),
      target_user_id: /^[0-9a-f-]{36}$/i.test(userId) ? userId : null,
      payment_id: paymentId || null,
      customer_id: String(value(data, 'customer_id') || '') || null,
      subscription_id: subscriptionId || null,
      product_code: product || terminal ? code || null : null,
      session_count: product?.sessions || 0,
      unlimited_plan: product?.unlimited || false,
      entitlement_ends_at: typeof endsAt === 'string' ? endsAt : null,
      amount_minor: Number.isSafeInteger(receivedAmount) ? receivedAmount : null,
      currency_code: receivedCurrency.slice(0, 3),
      safe_metadata: { dodo_event_type: eventType, dodo_subscription_id: subscriptionId || null },
    });
    if (error) return json(500, { error: 'webhook_processing_failed' });
    return json(200, applied);
  } catch {
    return json(400, { error: 'invalid_payload' });
  }
});
