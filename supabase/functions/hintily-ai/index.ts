import { corsHeaders } from '../_shared/cors.ts';
import { adminClient, authenticatedClient, json, readJson } from '../_shared/http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DATA_CHARS = 4_000_000;
const MAX_SINGLE_IMAGE_DATA_CHARS = 1_500_000;
// Keep the whole upstream operation below the desktop's 50-second deadline
// and the database request lease's 60-second expiry. The shorter per-attempt
// deadline guarantees that a configured fallback receives a real opportunity
// to start before the shared budget is exhausted.
const PROVIDER_TOTAL_TIMEOUT_MS = 40_000;
const PROVIDER_ATTEMPT_START_TIMEOUT_MS = 18_000;
const READINESS_TIMEOUT_MS = 8_000;
const response = (status: number, body: unknown) => json(status, body, corsHeaders);
const encoder = new TextEncoder();

type EnforcementResult = {
  ok?: boolean;
  state?: string;
  error?: string;
  claim_id?: string;
};
type ManagedProvider =
  | { kind: 'openai'; apiKey: string; model: string }
  | { kind: 'groq'; apiKey: string; model: string }
  | { kind: 'claude'; apiKey: string; model: string }
  | { kind: 'gemini'; apiKey: string; model: string };
type Image = { mimeType: string; data: string };

const geminiHeaders = (apiKey: string) => ({
  'Content-Type': 'application/json',
  'x-goog-api-key': apiKey,
});

const managedProviders = (): ManagedProvider[] => {
  const providers: ManagedProvider[] = [];
  const openAiKey = Deno.env.get('HINTILY_MANAGED_OPENAI_API_KEY')
    || Deno.env.get('HINTLY_MANAGED_OPENAI_API_KEY');
  if (openAiKey) {
    providers.push({
      kind: 'openai',
      apiKey: openAiKey,
      model: Deno.env.get('HINTILY_MANAGED_OPENAI_MODEL')
        || Deno.env.get('HINTLY_MANAGED_OPENAI_MODEL')
        || 'gpt-4.1-mini',
    });
  }
  const groqKey = Deno.env.get('HINTILY_MANAGED_GROQ_API_KEY')
    || Deno.env.get('HINTLY_MANAGED_GROQ_API_KEY');
  if (groqKey) {
    providers.push({
      kind: 'groq',
      apiKey: groqKey,
      model: Deno.env.get('HINTILY_MANAGED_GROQ_MODEL')
        || Deno.env.get('HINTLY_MANAGED_GROQ_MODEL')
        || 'meta-llama/llama-4-scout-17b-16e-instruct',
    });
  }
  const claudeKey = Deno.env.get('HINTILY_MANAGED_CLAUDE_API_KEY')
    || Deno.env.get('HINTLY_MANAGED_CLAUDE_API_KEY');
  if (claudeKey) {
    providers.push({
      kind: 'claude',
      apiKey: claudeKey,
      model: Deno.env.get('HINTILY_MANAGED_CLAUDE_MODEL')
        || Deno.env.get('HINTLY_MANAGED_CLAUDE_MODEL')
        || 'claude-sonnet-4-6',
    });
  }
  const geminiKey = Deno.env.get('HINTILY_GEMINI_API_KEY')
    || Deno.env.get('HINTLY_GEMINI_API_KEY')
    || Deno.env.get('GEMINI_API_KEY');
  if (geminiKey) {
    providers.push({
      kind: 'gemini',
      apiKey: geminiKey,
      model: Deno.env.get('HINTILY_MANAGED_GEMINI_MODEL')
        || Deno.env.get('HINTLY_MANAGED_GEMINI_MODEL')
        || 'gemini-2.5-flash',
    });
  }
  return providers;
};

const providerRequest = (
  provider: ManagedProvider,
  userText: string,
  system: string,
  images: Image[],
  stream: boolean,
  signal: AbortSignal,
) => {
  if (provider.kind === 'openai' || provider.kind === 'groq') {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
    for (const image of images) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${image.mimeType};base64,${image.data}` },
      });
    }
    return fetch(
      provider.kind === 'openai'
        ? 'https://api.openai.com/v1/chat/completions'
        : 'https://api.groq.com/openai/v1/chat/completions',
      {
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
        stream,
      }),
      signal,
    });
  }
  if (provider.kind === 'claude') {
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: userText }];
    for (const image of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.data },
      });
    }
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content }],
        temperature: 0.4,
        max_tokens: 8192,
        stream,
      }),
      signal,
    });
  }
  const parts: Array<Record<string, unknown>> = [{ text: userText }];
  for (const image of images) {
    parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
  }
  const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:${method}`,
    {
      method: 'POST',
      headers: geminiHeaders(provider.apiKey),
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      }),
      signal,
    },
  );
};

const readinessRequest = (provider: ManagedProvider) => {
  if (provider.kind === 'openai' || provider.kind === 'groq') {
    return fetch(
      provider.kind === 'openai'
        ? 'https://api.openai.com/v1/chat/completions'
        : 'https://api.groq.com/openai/v1/chat/completions',
      {
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
        stream: false,
      }),
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
    });
  }
  if (provider.kind === 'claude') {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': provider.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: 'Reply OK' }],
        temperature: 0,
        max_tokens: 2,
        stream: false,
      }),
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
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
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
    },
  );
};

const extractContent = (provider: ManagedProvider, payload: Record<string, unknown>) =>
  provider.kind === 'openai' || provider.kind === 'groq'
    ? String((payload.choices as any[])?.[0]?.message?.content || '')
    : provider.kind === 'claude'
      ? (Array.isArray(payload.content) ? payload.content : [])
        .map((part: any) => typeof part?.text === 'string' ? part.text : '')
        .join('')
    : (Array.isArray(payload.candidates) ? payload.candidates : [])
      .flatMap((candidate: any) => candidate?.content?.parts || [])
      .map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .join('');

const extractStreamDelta = (provider: ManagedProvider, payload: Record<string, unknown>) =>
  provider.kind === 'openai' || provider.kind === 'groq'
    ? String((payload.choices as any[])?.[0]?.delta?.content || '')
    : provider.kind === 'claude'
      ? String((payload.delta as any)?.text || '')
    : extractContent(provider, payload);

const parseImages = (body: Record<string, unknown>) => {
  const images: Image[] = [];
  let imageDataChars = 0;
  if (!Array.isArray(body.images)) return images;
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
  return images;
};

const createProviderOpener = (
  providers: ManagedProvider[],
  userText: string,
  system: string,
  images: Image[],
  stream: boolean,
) => {
  const startedAt = Date.now();
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(),
    PROVIDER_TOTAL_TIMEOUT_MS,
  );
  let nextProviderIndex = 0;
  let attempts = 0;
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(deadlineTimer);
    deadlineController.abort();
  };

  const openNext = async () => {
    while (nextProviderIndex < providers.length && !deadlineController.signal.aborted) {
      const provider = providers[nextProviderIndex++];
      attempts++;
      const remainingMs =
        PROVIDER_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      const attemptController = new AbortController();
      const attemptTimer = setTimeout(
        () => attemptController.abort(),
        Math.min(PROVIDER_ATTEMPT_START_TIMEOUT_MS, remainingMs),
      );
      try {
        const upstream = await providerRequest(
          provider,
          userText,
          system,
          images,
          stream,
          AbortSignal.any([deadlineController.signal, attemptController.signal]),
        );
        // The per-attempt timer protects time-to-headers only. Once a provider
        // has accepted a streaming request, the shared total deadline remains
        // authoritative for the response body.
        clearTimeout(attemptTimer);
        if (upstream.ok && upstream.body) return { upstream, provider, attempts };
        await upstream.body?.cancel().catch(() => undefined);
      } catch {
        // Configured fallbacks share one bounded overall deadline. Prompt and
        // response content are deliberately never logged here.
      } finally {
        clearTimeout(attemptTimer);
      }
    }
    return null;
  };

  return {
    openNext,
    dispose,
    get attempts() {
      return attempts;
    },
  };
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return response(405, { error: 'method_not_allowed' });
  const auth = await authenticatedClient(request);
  if (!auth) return response(401, { error: 'unauthorized' });

  try {
    const action = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
    const body = await readJson(request, MAX_BODY_BYTES);
    const purpose = body.purpose === 'post_meeting' ? 'post_meeting' : 'live';
    const sessionId = String(body.session_id || '');
    if (!UUID.test(sessionId)) return response(400, { error: 'invalid_session_id' });
    const { data: session, error } = await auth.client
      .from('business_sessions')
      .select('id,status,user_id')
      .eq('id', sessionId)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (error || !session) return response(404, { error: 'session_not_found' });

    const providers = managedProviders();
    if (action === 'ready') {
      if (session.status !== 'pending' && session.status !== 'active') {
        return response(409, { ready: false, error: 'session_not_ready' });
      }
      if (!providers.length) {
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
        return response(claim.error === 'readiness_in_progress' ? 429 : 409, {
          ready: false, error: claim.error || 'session_not_ready',
        });
      }
      if (claim.state === 'cached') return response(200, { ready: true, cached: true });
      const claimId = String(claim.claim_id || '');
      if (!UUID.test(claimId)) {
        return response(503, { ready: false, error: 'readiness_check_failed' });
      }
      let succeeded = false;
      try {
        // Probe every configured fallback concurrently. Sequential 8-second
        // probes can exceed the desktop's 20-second readiness deadline once
        // three or four managed providers are configured.
        const readinessResults = await Promise.all(
          providers.map(async (provider) => {
            let readiness: Response | null = null;
            let ready = false;
            try {
              readiness = await readinessRequest(provider);
              ready = readiness.ok;
            } catch {
              ready = false;
            } finally {
              await readiness?.body?.cancel().catch(() => undefined);
            }
            return ready;
          }),
        );
        // Results preserve provider order, so readiness remains deterministic
        // even though the network probes run in parallel.
        if (readinessResults.some(Boolean)) {
          succeeded = true;
          return response(200, { ready: true });
        }
        return response(503, { ready: false, error: 'managed_ai_upstream_unavailable' });
      } finally {
        await admin.rpc('hintily_ai_finish_readiness', {
          requested_session_id: sessionId,
          requested_user_id: auth.user.id,
          requested_claim_id: claimId,
          succeeded,
        });
      }
    }

    if (action !== 'chat' && action !== 'stream') {
      return response(404, { error: 'not_found' });
    }
    if (session.status !== 'active'
      && !(purpose === 'post_meeting' && session.status === 'completed')) {
      return response(409, { error: 'session_not_active' });
    }
    if (!providers.length) return response(503, { error: 'managed_ai_unconfigured' });
    const userText = String(body.message || '').slice(0, 120_000);
    const system = String(body.system || '').slice(0, 120_000);
    if (!userText.trim()) return response(400, { error: 'message_required' });
    const images = parseImages(body);
    const admin = adminClient();
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const { data: permitData, error: permitError } = await admin.rpc(
      'hintily_ai_begin_request',
      {
        requested_session_id: sessionId,
        requested_user_id: auth.user.id,
        requested_request_id: requestId,
        requested_purpose: purpose,
      },
    );
    if (permitError) return response(503, { error: 'ai_authorization_failed' });
    const permit = (permitData || {}) as EnforcementResult;
    if (!permit.ok) {
      return response(
        permit.error === 'rate_limit_exceeded'
          || permit.error === 'too_many_concurrent_requests' ? 429 : 409,
        { error: permit.error || 'ai_request_denied' },
      );
    }

    const providerOpener = createProviderOpener(
      providers, userText, system, images, action === 'stream',
    );
    const initiallyOpened = await providerOpener.openNext();
    if (!initiallyOpened) {
      providerOpener.dispose();
      await admin.rpc('hintily_ai_record_usage', {
        requested_request_id: requestId,
        requested_session_id: sessionId,
        requested_user_id: auth.user.id,
        requested_provider: 'unavailable',
        requested_model: 'unavailable',
        requested_status: 'failed',
        requested_input_characters: userText.length + system.length,
        requested_output_characters: 0,
        requested_image_count: images.length,
        requested_latency_ms: Date.now() - startedAt,
        requested_provider_attempts: providerOpener.attempts,
      });
      await admin.rpc('hintily_ai_end_request', {
        requested_session_id: sessionId,
        requested_user_id: auth.user.id,
        requested_request_id: requestId,
      });
      return response(502, { error: 'managed_ai_upstream_failed' });
    }

    if (action === 'chat') {
      let opened = initiallyOpened;
      let content = '';
      let status = 'failed';
      let auditProvider = opened.provider;
      try {
        while (opened) {
          auditProvider = opened.provider;
          const payload = await opened.upstream.json().catch(() => ({})) as Record<string, unknown>;
          content = extractContent(opened.provider, payload);
          if (content.trim()) {
            status = 'succeeded';
            return response(200, { content, model: opened.provider.model });
          }
          opened = await providerOpener.openNext();
        }
        return response(502, { error: 'managed_ai_empty_response' });
      } finally {
        providerOpener.dispose();
        await admin.rpc('hintily_ai_record_usage', {
          requested_request_id: requestId,
          requested_session_id: sessionId,
          requested_user_id: auth.user.id,
          requested_provider: auditProvider.kind,
          requested_model: auditProvider.model,
          requested_status: status,
          requested_input_characters: userText.length + system.length,
          requested_output_characters: content.length,
          requested_image_count: images.length,
          requested_latency_ms: Date.now() - startedAt,
          requested_provider_attempts: providerOpener.attempts,
        });
        await admin.rpc('hintily_ai_end_request', {
          requested_session_id: sessionId,
          requested_user_id: auth.user.id,
          requested_request_id: requestId,
        });
      }
    }

    let opened = initiallyOpened;
    let upstreamReader = opened.upstream.body!.getReader();
    let upstreamDecoder = new TextDecoder();
    let buffer = '';
    let outputCharacters = 0;
    let providerOutputCharacters = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        while (true) {
          try {
            const { done, value } = await upstreamReader.read();
            if (done) {
              buffer += upstreamDecoder.decode();
              if (buffer.trim()) processLine(buffer, controller);
              if (providerOutputCharacters === 0) {
                if (await switchToFallback()) continue;
                controller.error(new Error('managed_ai_empty_response'));
                await finish('failed');
                return;
              }
              controller.enqueue(encoder.encode(
                `data: ${JSON.stringify({ done: true, model: opened!.provider.model })}\n\n`,
              ));
              controller.close();
              await finish('succeeded');
              return;
            }
            buffer += upstreamDecoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) processLine(line, controller);
            return;
          } catch {
            if (providerOutputCharacters === 0 && await switchToFallback()) continue;
            controller.error(new Error('managed_ai_stream_failed'));
            await finish('failed');
            return;
          }
        }
      },
      async cancel() {
        await upstreamReader.cancel().catch(() => undefined);
        await finish('cancelled');
      },
    });
    let finished = false;
    function processLine(line: string, controller: ReadableStreamDefaultController<Uint8Array>) {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (payload.error) throw new Error('managed_ai_provider_stream_error');
      const delta = extractStreamDelta(opened!.provider, payload);
      if (!delta) return;
      outputCharacters += delta.length;
      providerOutputCharacters += delta.length;
      controller.enqueue(encoder.encode(
        `data: ${JSON.stringify({ content: delta })}\n\n`,
      ));
    }
    async function switchToFallback(): Promise<boolean> {
      await upstreamReader.cancel().catch(() => undefined);
      const fallback = await providerOpener.openNext();
      if (!fallback) return false;
      opened = fallback;
      upstreamReader = fallback.upstream.body!.getReader();
      upstreamDecoder = new TextDecoder();
      buffer = '';
      providerOutputCharacters = 0;
      return true;
    }
    async function finish(status: 'succeeded' | 'failed' | 'cancelled') {
      if (finished) return;
      finished = true;
      providerOpener.dispose();
      await admin.rpc('hintily_ai_record_usage', {
        requested_request_id: requestId,
        requested_session_id: sessionId,
        requested_user_id: auth.user.id,
        requested_provider: opened!.provider.kind,
        requested_model: opened!.provider.model,
        requested_status: status,
        requested_input_characters: userText.length + system.length,
        requested_output_characters: outputCharacters,
        requested_image_count: images.length,
        requested_latency_ms: Date.now() - startedAt,
        requested_provider_attempts: providerOpener.attempts,
      });
      await admin.rpc('hintily_ai_end_request', {
        requested_session_id: sessionId,
        requested_user_id: auth.user.id,
        requested_request_id: requestId,
      });
    }
    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    const code = error instanceof Error && /request_too_large|invalid_json/.test(error.message)
      ? error.message : 'managed_ai_request_failed';
    return response(code === 'managed_ai_request_failed' ? 500 : 400, { error: code });
  }
});
