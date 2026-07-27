import { productMap, sha256, verifyDodoSignature } from '../_shared/dodo.ts';
import { adminClient, json } from '../_shared/http.ts';

const value = (object: Record<string, unknown>, ...names: string[]) => {
  for (const name of names) if (object[name] != null) return object[name];
  return null;
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
    const subscriptionId = String(value(data, 'subscription_id') || '');
    const admin = adminClient();
    if ((!code || !userId) && subscriptionId) {
      const { data: existing } = await admin.from('entitlements')
        .select('user_id,plan_code').eq('source', 'dodo')
        .eq('source_reference', subscriptionId).maybeSingle();
      code ||= String(existing?.plan_code || '');
      userId ||= String(existing?.user_id || '');
    }
    if ((!code || !userId) && paymentId) {
      const { data: existing } = await admin.from('purchases')
        .select('user_id,product_code').eq('provider', 'dodo')
        .eq('provider_payment_id', paymentId).maybeSingle();
      code ||= String(existing?.product_code || '');
      userId ||= String(existing?.user_id || '');
    }
    const product = productMap()[code];
    let endsAt = value(data, 'next_billing_date', 'expires_at');
    if (product?.unlimited && product.interval !== 'lifetime' && typeof endsAt !== 'string') {
      const fallbackDays = product.interval === 'year' ? 370 : product.interval === 'quarter' ? 100 : 35;
      endsAt = new Date(Date.now() + fallbackDays * 86_400_000).toISOString();
    }
    const terminal = /^(payment\.(failed|cancelled)|subscription\.(cancelled|expired|failed|on_hold)|refund\.succeeded|dispute\.)/.test(eventType);
    const { data: applied, error } = await admin.rpc('hintily_apply_dodo_event', {
      event_id: id,
      event_type: eventType,
      event_occurred_at: eventTimestamp,
      event_payload_sha256: await sha256(raw),
      target_user_id: /^[0-9a-f-]{36}$/i.test(userId) ? userId : null,
      payment_id: paymentId || null,
      customer_id: String(value(data, 'customer_id') || '') || null,
      subscription_id: subscriptionId || null,
      product_code: product || terminal ? code || null : null,
      session_count: product?.sessions || 0,
      unlimited_plan: product?.unlimited || false,
      entitlement_ends_at: typeof endsAt === 'string' ? endsAt : null,
      amount_minor: Number.isSafeInteger(Number(value(data, 'total_amount', 'amount')))
        ? Number(value(data, 'total_amount', 'amount')) : null,
      currency_code: String(value(data, 'currency') || '').slice(0, 3),
      safe_metadata: { dodo_event_type: eventType, dodo_subscription_id: subscriptionId || null },
    });
    if (error) return json(500, { error: 'webhook_processing_failed' });
    return json(200, applied);
  } catch {
    return json(400, { error: 'invalid_payload' });
  }
});
