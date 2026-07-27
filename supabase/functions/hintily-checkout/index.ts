import { corsHeaders } from '../_shared/cors.ts';
import { productMap } from '../_shared/dodo.ts';
import { authenticatedClient, json, readJson } from '../_shared/http.ts';

const response = (status: number, body: unknown) => json(status, body, corsHeaders);

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' });
  const auth = await authenticatedClient(request);
  if (!auth) return response(401, { error: 'unauthorized' });
  try {
    const body = await readJson(request);
    const code = String(body.product_code || '');
    const product = productMap()[code];
    if (!product) return response(400, { error: 'unknown_product' });
    const apiKey = Deno.env.get('DODO_PAYMENTS_API_KEY');
    const mode = Deno.env.get('DODO_PAYMENTS_ENVIRONMENT') || 'test_mode';
    const returnUrl = Deno.env.get('HINTILY_CHECKOUT_RETURN_URL');
    const cancelUrl = Deno.env.get('HINTILY_CHECKOUT_CANCEL_URL');
    if (!apiKey || !returnUrl) return response(503, { error: 'checkout_unconfigured' });
    const endpoint = mode === 'live_mode' ? 'https://live.dodopayments.com/checkouts' : 'https://test.dodopayments.com/checkouts';
    const dodo = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_cart: [{ product_id: product.productId, quantity: 1 }],
        customer: auth.user.email ? {
          email: auth.user.email,
          name: auth.user.user_metadata?.full_name || auth.user.user_metadata?.name || undefined,
        } : undefined,
        return_url: returnUrl,
        cancel_url: cancelUrl || undefined,
        metadata: { hintily_user_id: auth.user.id, hintily_product_code: code },
      }),
    });
    const payload = await dodo.json().catch(() => ({})) as Record<string, unknown>;
    const checkoutUrl = typeof payload.checkout_url === 'string' ? payload.checkout_url : '';
    if (!dodo.ok || !checkoutUrl.startsWith('https://')) {
      return response(502, { error: 'checkout_creation_failed' });
    }
    return response(200, {
      checkout_url: checkoutUrl,
      session_id: typeof payload.session_id === 'string' ? payload.session_id : null,
    });
  } catch {
    return response(400, { error: 'invalid_checkout_request' });
  }
});
