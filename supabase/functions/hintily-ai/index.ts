import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, authenticatedClient, json, readJson } from '../_shared/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const response = (status: number, body: unknown) => json(status, body, corsHeaders);
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DATA_CHARS = 4_000_000;
const MAX_SINGLE_IMAGE_DATA_CHARS = 1_500_000;
type EnforcementResult = {
  ok?: boolean;
  state?: string;
  error?: string;
  claim_id?: string;
};
type ManagedProvider =
  | { kind: 'openai'; apiKey: string; model: string }
  | { kind: 'gemini'; apiKey: string; model: string };

const geminiHeaders = (apiKey: string) => ({
  'Content-Type': 'application/json',
  // Keep credentials out of URLs so gateways and request logs cannot capture
  // the managed provider key.
  'x-goog-api-key': apiKey,
});

const managedProvider = (): ManagedProvider | null => {
  const openAiKey = Deno.env.get('HINTILY_MANAGED_OPENAI_API_KEY')
    || Deno.env.get('HINTLY_MANAGED_OPENAI_API_KEY');
  if (openAiKey) {
    return {
      kind: 'openai',
      apiKey: openAiKey,
      model: Deno.env.get('HINTILY_MANAGED_OPENAI_MODEL')
        || Deno.env.get('HINTLY_MANAGED_OPENAI_MODEL')
        || 'gpt-4.1-mini',
    };
  }
  const geminiKey = Deno.env.get('HINTILY_GEMINI_API_KEY')
    || Deno.env.get('HINTLY_GEMINI_API_KEY')
    || Deno.env.get('GEMINI_API_KEY');
  return geminiKey
    ? {
      kind: 'gemini',
      apiKey: geminiKey,
      model: Deno.env.get('HINTILY_MANAGED_GEMINI_MODEL')
        || Deno.env.get('HINTLY_MANAGED_GEMINI_MODEL')
        || 'gemini-2.5-flash',
    }
    : null;
};

const checkProviderReadiness = (provider: ManagedProvider): Promise<Response> => {
  if (provider.kind === 'openai') {
    return fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: 'Reply OK' }],
        temperature: 0,
        max_completion_tokens: 2,
      }),
      signal: AbortSignal.timeout(8_000),
    });
  }
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent`,
    {
      method: 'POST',
      headers: geminiHeaders(provider.apiKey),
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply OK' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 2 },
      }),
      signal: AbortSignal.timeout(8_000),
    },
  );
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' });
  const auth = await authenticatedClient(request);
  if (!auth) return response(401, { error: 'unauthorized' });

  try {
    const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
    const body = await readJson(request, MAX_BODY_BYTES);
    const sessionId = String(body.session_id || '');
    if (!UUID.test(sessionId)) return response(400, { error: 'invalid_session_id' });

    const { data: session, error } = await auth.client
      .from('business_sessions')
      .select('id,status,user_id')
      .eq('id', sessionId)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (error || !session) return response(404, { error: 'session_not_found' });

    const provider = managedProvider();
    if (action === 'ready') {
      const validState = session.status === 'pending' || session.status === 'active';
      if (!validState) {
        return response(409, { ready: false, error: 'session_not_ready' });
      }
      if (!provider) {
        return response(503, { ready: false, error: 'managed_ai_unconfigured' });
      }
      const admin = adminClient();
      const { data: claimData, error: claimError } = await admin.rpc(
        'hintily_ai_claim_readiness',
        { requested_session_id: sessionId, requested_user_id: auth.user.id },
      );
      if (claimError) return response(503, { ready: false, error: 'readiness_check_failed' });
      const claim = (claimData || {}) as EnforcementResult;
      if (!claim.ok) {
        const status = claim.error === 'readiness_in_progress' ? 429 : 409;
        return response(status, { ready: false, error: claim.error || 'session_not_ready' });
      }
      if (claim.state === 'cached') return response(200, { ready: true, cached: true });
      const readinessClaimId = String(claim.claim_id || '');
      if (!UUID.test(readinessClaimId)) {
        return response(503, { ready: false, error: 'readiness_check_failed' });
      }

      // Validate the actual credential and configured model before the desktop
      // activates a single-use session. Merely finding an environment variable
      // would consume sessions when the key is revoked or the model is denied.
      let readinessSucceeded = false;
      try {
        const readiness = await checkProviderReadiness(provider);
        if (!readiness.ok) {
          return response(503, { ready: false, error: 'managed_ai_upstream_unavailable' });
        }
        readinessSucceeded = true;
        return response(200, { ready: true });
      } finally {
        await admin.rpc('hintily_ai_finish_readiness', {
          requested_session_id: sessionId,
          requested_user_id: auth.user.id,
          requested_claim_id: readinessClaimId,
          succeeded: readinessSucceeded,
        });
      }
    }
    if (action !== 'chat') return response(404, { error: 'not_found' });
    if (session.status !== 'active') return response(409, { error: 'session_not_active' });
    if (!provider) return response(503, { error: 'managed_ai_unconfigured' });

    const userText = String(body.message || '').slice(0, 120_000);
    const system = String(body.system || '').slice(0, 120_000);
    if (!userText.trim()) return response(400, { error: 'message_required' });
    const images: Array<{ mimeType: string; data: string }> = [];
    let imageDataChars = 0;
    if (Array.isArray(body.images)) {
      for (const candidate of body.images.slice(0, 4)) {
        if (!candidate || typeof candidate !== 'object') continue;
        const image = candidate as Record<string, unknown>;
        const mimeType = String(image.mime_type || '');
        const data = String(image.data || '');
        if (/^image\/(png|jpeg|webp)$/.test(mimeType)
          && data.length <= MAX_SINGLE_IMAGE_DATA_CHARS
          && imageDataChars + data.length <= MAX_IMAGE_DATA_CHARS) {
          images.push({ mimeType, data });
          imageDataChars += data.length;
        }
      }
    }

    const admin = adminClient();
    const requestId = crypto.randomUUID();
    const { data: permitData, error: permitError } = await admin.rpc(
      'hintily_ai_begin_request',
      {
        requested_session_id: sessionId,
        requested_user_id: auth.user.id,
        requested_request_id: requestId,
      },
    );
    if (permitError) return response(503, { error: 'ai_authorization_failed' });
    const permit = (permitData || {}) as EnforcementResult;
    if (!permit.ok) {
      const status = permit.error === 'rate_limit_exceeded'
          || permit.error === 'too_many_concurrent_requests'
        ? 429 : 409;
      return response(status, { error: permit.error || 'ai_request_denied' });
    }

    try {
      let upstream: Response;
      if (provider.kind === 'openai') {
        const content: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
        for (const image of images) {
          content.push({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.data}` },
          });
        }
        upstream = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${provider.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: provider.model,
            messages: [
              ...(system ? [{ role: 'system', content: system }] : []),
              { role: 'user', content },
            ],
            temperature: 0.4,
            max_completion_tokens: 8192,
          }),
          signal: AbortSignal.timeout(45_000),
        });
      } else {
        const parts: Array<Record<string, unknown>> = [{ text: userText }];
        for (const image of images) {
          parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
        }
        upstream = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent`,
          {
            method: 'POST',
            headers: geminiHeaders(provider.apiKey),
            body: JSON.stringify({
              ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
              contents: [{ role: 'user', parts }],
              generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
            }),
            signal: AbortSignal.timeout(45_000),
          },
        );
      }
      const payload = await upstream.json().catch(() => ({})) as Record<string, unknown>;
      if (!upstream.ok) return response(502, { error: 'managed_ai_upstream_failed' });
      const content = provider.kind === 'openai'
        ? String((payload.choices as any[])?.[0]?.message?.content || '')
        : (Array.isArray(payload.candidates) ? payload.candidates : [])
          .flatMap((candidate: any) => candidate?.content?.parts || [])
          .map((part: any) => typeof part?.text === 'string' ? part.text : '')
          .join('');
      if (!content.trim()) return response(502, { error: 'managed_ai_empty_response' });
      return response(200, { content, model: provider.model });
    } finally {
      await admin.rpc('hintily_ai_end_request', {
        requested_session_id: sessionId,
        requested_user_id: auth.user.id,
        requested_request_id: requestId,
      });
    }
  } catch (error) {
    const code = error instanceof Error && /request_too_large|invalid_json/.test(error.message)
      ? error.message : 'managed_ai_request_failed';
    return response(code === 'managed_ai_request_failed' ? 500 : 400, { error: code });
  }
});
