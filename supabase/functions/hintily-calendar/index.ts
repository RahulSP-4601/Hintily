import { corsHeaders } from '../_shared/cors.ts';
import {
  authenticatedClient,
  consumeActionRate,
  json,
  readJson,
} from '../_shared/http.ts';

const response = (status: number, body: unknown) => json(status, body, corsHeaders);
const REDIRECT_URI = 'http://localhost:11111/auth/callback';
const MAX_BODY_BYTES = 16_384;

const requiredEnv = (name: string): string => {
  const value = (Deno.env.get(name) || '').trim();
  if (!value) throw new Error('calendar_service_unconfigured');
  return value;
};

const exchangeAtGoogle = async (
  fields: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> => {
  const clientId = requiredEnv('HINTILY_GOOGLE_CALENDAR_CLIENT_ID');
  const clientSecret = requiredEnv('HINTILY_GOOGLE_CALENDAR_CLIENT_SECRET');
  return fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }),
    signal,
  });
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' });
  const auth = await authenticatedClient(request);
  if (!auth) return response(401, { error: 'unauthorized' });

  try {
    const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
    if (action !== 'exchange' && action !== 'refresh') {
      return response(404, { error: 'not_found' });
    }
    const allowed = await consumeActionRate(
      auth.client,
      action === 'exchange' ? 'calendar_exchange' : 'calendar_refresh',
      action === 'exchange' ? 5 : 20,
      60,
    );
    if (!allowed) return response(429, { error: 'rate_limit_exceeded' });

    const body = await readJson(request, MAX_BODY_BYTES);
    let fields: Record<string, string>;
    if (action === 'exchange') {
      const code = String(body.code || '').trim();
      const redirectUri = String(body.redirect_uri || '').trim();
      if (!code || code.length > 4096) return response(400, { error: 'invalid_code' });
      if (redirectUri !== REDIRECT_URI) return response(400, { error: 'invalid_redirect_uri' });
      fields = {
        code,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code',
      };
    } else {
      const refreshToken = String(body.refresh_token || '').trim();
      if (!refreshToken || refreshToken.length > 4096) {
        return response(400, { error: 'invalid_refresh_token' });
      }
      fields = { refresh_token: refreshToken, grant_type: 'refresh_token' };
    }

    const upstream = await exchangeAtGoogle(fields, AbortSignal.timeout(12_000));
    const payload = await upstream.json().catch(() => ({})) as Record<string, unknown>;
    if (!upstream.ok) {
      const terminal = upstream.status >= 400 && upstream.status < 500;
      return response(terminal ? 400 : 502, {
        error: action === 'exchange' ? 'calendar_exchange_failed' : 'calendar_refresh_failed',
      });
    }
    const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
    const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined;
    const expiresIn = Number(payload.expires_in);
    if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      return response(502, { error: 'invalid_calendar_provider_response' });
    }
    return response(200, {
      access_token: accessToken,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      expires_in: Math.min(Math.floor(expiresIn), 86_400),
      token_type: 'Bearer',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message === 'request_too_large' || message === 'invalid_json') {
      return response(400, { error: message });
    }
    if (message === 'calendar_service_unconfigured') {
      return response(503, { error: message });
    }
    return response(502, { error: 'calendar_service_unavailable' });
  }
});
