import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEARTBEAT_MS = 15_000;
const LEASE_GUARD_MS = 10_000;
const FINAL_METER_TIMEOUT_MS = 2_000;
const MAX_TRANSIENT_LEASE_FAILURES = 3;
const STARTUP_BUFFER_LIMIT_BYTES = 2 * 1024 * 1024;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_FORBIDDEN = 4403;
const CLOSE_EXHAUSTED = 4402;
const CLOSE_LIMIT = 4429;

const reject = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

Deno.serve(async (request) => {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return reject(426, 'websocket_required');
  }
  const authorization = request.headers.get('authorization');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const deepgramKey = Deno.env.get('HINTILY_MANAGED_DEEPGRAM_API_KEY')
    || Deno.env.get('HINTLY_MANAGED_DEEPGRAM_API_KEY')
    || Deno.env.get('DEEPGRAM_API_KEY');
  if (!authorization?.startsWith('Bearer ') || !supabaseUrl || !anonKey || !deepgramKey) {
    return reject(401, 'unauthorized');
  }

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) return reject(401, 'unauthorized');

  const requestUrl = new URL(request.url);
  const sessionId = requestUrl.searchParams.get('hintily_session_id') || '';
  if (!UUID.test(sessionId)) return reject(400, 'invalid_session_id');
  requestUrl.searchParams.delete('hintily_session_id');
  const channel = requestUrl.searchParams.get('hintily_channel') || '';
  if (channel !== 'interviewer' && channel !== 'user') {
    return reject(400, 'invalid_channel');
  }
  requestUrl.searchParams.delete('hintily_channel');
  const leaseOwnerId = requestUrl.searchParams.get('hintily_lease_owner_id') || '';
  if (!UUID.test(leaseOwnerId)) return reject(400, 'invalid_lease_owner_id');
  requestUrl.searchParams.delete('hintily_lease_owner_id');
  const leaseId = crypto.randomUUID();
  const { data: businessSession, error: sessionError } = await client
    .from('business_sessions')
    .select('id')
    .eq('id', sessionId)
    .eq('status', 'active')
    .maybeSingle();
  if (sessionError || !businessSession) return reject(403, 'session_not_active');
  const { error: leaseError } = await client.rpc('hintily_acquire_stream_lease', {
    requested_session_id: sessionId,
    requested_channel: channel,
    requested_lease_id: leaseId,
    requested_lease_owner_id: leaseOwnerId,
  });
  if (leaseError) return reject(429, 'stream_limit_reached');

  const { socket, response } = Deno.upgradeWebSocket(request);
  let upstream: WebSocket | null = null;
  let heartbeatTimer: number | null = null;
  let leaseGuardTimer: number | null = null;
  let closing = false;
  let closed = false;
  let leaseGuardInFlight = false;
  let streamReady = false;
  let transientLeaseFailures = 0;
  let startupBufferBytes = 0;
  const startupBuffer: Array<string | ArrayBuffer | Blob> = [];

  const releaseLease = async () => {
    await client.rpc('hintily_release_stream_lease', {
      requested_session_id: sessionId,
      requested_channel: channel,
      requested_lease_id: leaseId,
    });
  };

  const closeBothNow = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    if (leaseGuardTimer !== null) clearInterval(leaseGuardTimer);
    heartbeatTimer = null;
    leaseGuardTimer = null;
    startupBuffer.length = 0;
    startupBufferBytes = 0;
    void releaseLease();
    try { upstream?.close(code, reason); } catch { /* already closed */ }
    try { socket.close(code, reason); } catch { /* already closed */ }
  };

  const meter = async (final = false): Promise<void> => {
    if (closed || (closing && !final) || !streamReady) return;
    const { data, error } = await client.rpc('hintily_proxy_heartbeat', {
      requested_session_id: sessionId,
      requested_channel: channel,
      requested_lease_id: leaseId,
    });
    if (error) {
      closeBothNow(CLOSE_FORBIDDEN, 'session_not_active');
      return;
    }
    const usage = data as {
      accepted_seconds?: number;
      remaining_seconds?: number | null;
      exhausted?: boolean;
    };
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'HintilyUsage', ...usage }));
    }
    if (usage.exhausted && !closing) {
      void finishAndClose(CLOSE_EXHAUSTED, 'session_time_exhausted', false);
    }
  };

  const finishAndClose = async (
    code: number,
    reason: string,
    chargeFinalUsage: boolean,
  ): Promise<void> => {
    if (closing || closed) return;
    closing = true;
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    if (leaseGuardTimer !== null) clearInterval(leaseGuardTimer);
    heartbeatTimer = null;
    leaseGuardTimer = null;
    try {
      if (chargeFinalUsage && streamReady) {
        let timeout: number | null = null;
        try {
          await Promise.race([
            meter(true),
            new Promise<void>(resolve => {
              timeout = setTimeout(resolve, FINAL_METER_TIMEOUT_MS);
            }),
          ]).catch(() => undefined);
        } finally {
          if (timeout !== null) clearTimeout(timeout);
        }
      }
    } finally {
      closeBothNow(code, reason);
    }
  };

  const guardLease = async () => {
    if (closed || closing || leaseGuardInFlight) return;
    leaseGuardInFlight = true;
    try {
      const { error } = await client.rpc('hintily_renew_stream_lease', {
        requested_session_id: sessionId,
        requested_channel: channel,
        requested_lease_id: leaseId,
      });
      if (closed || closing) return;
      if (!error) {
        transientLeaseFailures = 0;
        return;
      }
      const confirmedLeaseLoss =
        error.code === 'P0001' || error.code === '28000' ||
        String(error.message || '').includes('stream_lease_expired');
      if (!confirmedLeaseLoss) transientLeaseFailures++;
      if (confirmedLeaseLoss || transientLeaseFailures >= MAX_TRANSIENT_LEASE_FAILURES) {
        void finishAndClose(CLOSE_FORBIDDEN, 'stream_lease_replaced', streamReady);
      }
    } finally {
      leaseGuardInFlight = false;
    }
  };

  socket.onopen = () => {
    const deepgramUrl = new URL('wss://api.deepgram.com/v1/listen');
    const allowedLanguages = new Set([
      'multi', 'en', 'id', 'ru', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko',
      'zh', 'tr', 'uk', 'ro', 'pl', 'nl', 'ar', 'hi', 'sv', 'no', 'da',
      'cs', 'hu', 'vi', 'th', 'el', 'bg', 'he', 'ms', 'fi',
    ]);
    const language = requestUrl.searchParams.get('language') || 'en';
    const sampleRate = requestUrl.searchParams.get('sample_rate') || '16000';
    const channels = requestUrl.searchParams.get('channels') || '1';
    deepgramUrl.searchParams.set('model', 'nova-3');
    deepgramUrl.searchParams.set('language', allowedLanguages.has(language) ? language : 'en');
    deepgramUrl.searchParams.set('encoding', 'linear16');
    deepgramUrl.searchParams.set(
      'sample_rate',
      ['8000', '16000', '24000', '32000', '44100', '48000'].includes(sampleRate)
        ? sampleRate : '16000',
    );
    deepgramUrl.searchParams.set('channels', channels === '2' ? '2' : '1');
    deepgramUrl.searchParams.set('smart_format', 'true');
    deepgramUrl.searchParams.set('interim_results', 'true');
    deepgramUrl.searchParams.set('endpointing', '300');
    deepgramUrl.searchParams.set('utterance_end_ms', '1000');
    deepgramUrl.searchParams.set('vad_events', 'true');
    if (channel === 'interviewer' && requestUrl.searchParams.get('diarize') === 'true') {
      deepgramUrl.searchParams.set('diarize', 'true');
    }
    upstream = new WebSocket(deepgramUrl, ['token', deepgramKey]);
    upstream.binaryType = 'arraybuffer';
    upstream.onopen = async () => {
      if (closing || closed) return;
      const { error } = await client.rpc('hintily_mark_stream_ready', {
        requested_session_id: sessionId,
        requested_channel: channel,
        requested_lease_id: leaseId,
      });
      if (error || closing || closed) {
        if (error) await finishAndClose(CLOSE_FORBIDDEN, 'stream_lease_replaced', false);
        return;
      }
      streamReady = true;
      for (const frame of startupBuffer) upstream?.send(frame);
      startupBuffer.length = 0;
      startupBufferBytes = 0;
      await meter();
      if (closing || closed) return;
      heartbeatTimer = setInterval(() => void meter(), HEARTBEAT_MS);
    };
    upstream.onmessage = event => {
      if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
    };
    upstream.onerror = () => void finishAndClose(1011, 'provider_error', true);
    upstream.onclose = () => void finishAndClose(1011, 'provider_closed', true);
  };
  leaseGuardTimer = setInterval(() => void guardLease(), LEASE_GUARD_MS);
  socket.onmessage = event => {
    if (streamReady && upstream?.readyState === WebSocket.OPEN) {
      upstream.send(event.data);
      return;
    }
    if (closing || closed) return;
    const frameBytes = typeof event.data === 'string'
      ? new TextEncoder().encode(event.data).byteLength
      : event.data instanceof ArrayBuffer
        ? event.data.byteLength
        : event.data instanceof Blob
          ? event.data.size
          : STARTUP_BUFFER_LIMIT_BYTES + 1;
    if (startupBufferBytes + frameBytes > STARTUP_BUFFER_LIMIT_BYTES) {
      void finishAndClose(CLOSE_LIMIT, 'startup_buffer_exceeded', false);
      return;
    }
    startupBuffer.push(event.data);
    startupBufferBytes += frameBytes;
  };
  socket.onerror = () => void finishAndClose(1011, 'client_error', true);
  socket.onclose = () => {
    void finishAndClose(1000, 'client_closed', true);
  };

  return response;
});
