import { corsHeaders } from '../_shared/cors.ts';
import { authenticatedClient, json, readJson } from '../_shared/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const response = (status: number, body: unknown) => json(status, body, corsHeaders);
const rpcError = (error: { message?: string } | null) => {
  const code = String(error?.message || 'business_request_failed').match(
    /no_time_remaining|session_already_active|session_surface_mismatch|session_not_found|session_not_active|session_not_activatable|ai_provider_not_ready|stt_providers_not_ready|post_processing_not_allowed|invalid_heartbeat/,
  )?.[0];
  return response(code === 'no_time_remaining' ? 402 : code ? 409 : 500, {
    error: code || 'business_request_failed',
  });
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'GET' && request.method !== 'POST') {
    return response(405, { error: 'method_not_allowed' });
  }
  const auth = await authenticatedClient(request);
  if (!auth) return response(401, { error: 'unauthorized' });

  const url = new URL(request.url);
  const action = url.pathname.split('/').filter(Boolean).at(-1);
  try {
    if (request.method === 'GET' && action === 'state') {
      const { data, error } = await auth.client.rpc('hintily_account_state_v2');
      return error ? rpcError(error) : response(200, data);
    }
    if (request.method === 'GET' && action === 'purchases') {
      const { data, error } = await auth.client
        .from('purchases')
        .select('id,product_code,amount_minor,currency,status,purchased_at,created_at')
        .order('created_at', { ascending: false })
        .limit(100);
      return error ? response(500, { error: 'purchase_history_failed' }) : response(200, {
        purchases: data || [],
      });
    }
    if (request.method === 'POST' && action === 'ensure-trial') {
      const { data, error } = await auth.client.rpc('hintily_ensure_trial');
      return error ? rpcError(error) : response(200, data);
    }

    const body = await readJson(request);
    if (action === 'authorize') {
      const clientSessionId = String(body.client_session_id || '');
      const surface = String(body.surface || '');
      if (!UUID.test(clientSessionId)) return response(400, { error: 'invalid_client_session_id' });
      if (surface !== 'interview_helper' && surface !== 'meeting') {
        return response(400, { error: 'invalid_session_surface' });
      }
      const { data, error } = await auth.client.rpc('hintily_authorize_session', {
        requested_client_session_id: clientSessionId,
        requested_surface: surface,
      });
      return error ? rpcError(error) : response(200, data);
    }
    const sessionId = String(body.session_id || '');
    if (!UUID.test(sessionId)) return response(400, { error: 'invalid_session_id' });

    if (action === 'stream-ready') {
      const channel = String(body.channel || '');
      if (channel !== 'interviewer' && channel !== 'user') {
        return response(400, { error: 'invalid_stream_channel' });
      }
      const { data, error } = await auth.client.rpc('hintily_stream_channel_ready', {
        requested_session_id: sessionId,
        requested_channel: channel,
      });
      return error ? rpcError(error) : response(200, { ready: data === true });
    }
    if (action === 'activate') {
      const { data, error } = await auth.client.rpc('hintily_activate_session', {
        requested_session_id: sessionId,
      });
      return error ? rpcError(error) : response(200, data);
    }
    if (action === 'begin-post-processing') {
      const { data, error } = await auth.client.rpc('hintily_begin_post_processing', {
        requested_session_id: sessionId,
      });
      return error ? rpcError(error) : response(200, data);
    }
    if (action === 'heartbeat') return response(410, { error: 'relay_heartbeat_required' });
    if (action === 'complete') {
      const failure = body.failure_code == null ? null : String(body.failure_code).slice(0, 80);
      const { data, error } = await auth.client.rpc('hintily_finalize_session', {
        requested_session_id: sessionId,
        requested_failure_code: failure,
      });
      return error ? rpcError(error) : response(200, data);
    }
    return response(404, { error: 'not_found' });
  } catch (error) {
    const code = error instanceof Error && /request_too_large|invalid_json/.test(error.message)
      ? error.message : 'business_request_failed';
    return response(code === 'business_request_failed' ? 500 : 400, { error: code });
  }
});
