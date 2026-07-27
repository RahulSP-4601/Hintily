import { shell } from 'electron';
import { getHintilyConfig } from '../../config/hintily';
import { HintilyAuthService } from '../auth/HintilyAuthService';
import type {
  HintilyAccountState,
  HintilyBusinessResult,
  HintilyHeartbeatResult,
  HintilySessionAuthorization,
} from './types';

const TIMEOUT_MS = 12_000;
const RETRY_DELAYS = [0, 350, 1_000];
const safeCode = (value: unknown) => String(value || 'request_failed')
  .replace(/[^a-z0-9_-]/gi, '_').slice(0, 100);

export class HintilyBusinessService {
  private static instance: HintilyBusinessService | null = null;
  private readonly auth = HintilyAuthService.getInstance();
  private readonly config = getHintilyConfig();

  static getInstance(): HintilyBusinessService {
    if (!this.instance) this.instance = new HintilyBusinessService();
    return this.instance;
  }

  private async request<T>(
    functionName: string,
    action: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>,
    options?: { accessToken?: string; retry?: boolean },
  ): Promise<HintilyBusinessResult<T>> {
    const token = options?.accessToken ?? this.auth.getAccessToken();
    if (!token) return { ok: false, error: 'signed_out', status: 401 };
    const retryDelays = options?.retry === false ? [0] : RETRY_DELAYS;
    for (let attempt = 0; attempt < retryDelays.length; attempt++) {
      if (retryDelays[attempt]) await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(
          `${this.config.supabaseUrl}/functions/v1/${functionName}/${action}`,
          {
            method,
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${token}`,
              apikey: this.config.supabaseAnonKey,
              'Content-Type': 'application/json',
              'X-Client-Info': 'hintily-desktop',
            },
            body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
          },
        );
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (response.ok) return { ok: true, data: payload as T };
        const error = safeCode(payload.error || `http_${response.status}`);
        if (response.status < 500 && response.status !== 429) {
          return { ok: false, error, status: response.status };
        }
        if (attempt === retryDelays.length - 1) return { ok: false, error, status: response.status };
      } catch (error) {
        if (attempt === retryDelays.length - 1) {
          return {
            ok: false,
            error: error instanceof Error && error.name === 'AbortError' ? 'request_timeout' : 'offline',
            offline: true,
          };
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: 'request_failed' };
  }

  ensureTrial() {
    return this.request<HintilyAccountState>('hintily-business', 'ensure-trial', 'POST');
  }
  getAccountState() {
    return this.request<HintilyAccountState>('hintily-business', 'state', 'GET');
  }
  authorizeSession(clientSessionId: string) {
    return this.request<HintilySessionAuthorization>('hintily-business', 'authorize', 'POST', {
      client_session_id: clientSessionId,
    });
  }
  activateSession(sessionId: string) {
    return this.request<{ session_id: string; status: 'active' }>(
      'hintily-business', 'activate', 'POST', { session_id: sessionId },
    );
  }
  heartbeat(sessionId: string, sequenceNo: number, activeSeconds: number) {
    return this.request<HintilyHeartbeatResult>('hintily-business', 'heartbeat', 'POST', {
      session_id: sessionId, sequence_no: sequenceNo, active_seconds: activeSeconds,
    });
  }
  captureAccessToken(): string | null {
    return this.auth.getAccessToken();
  }
  completeSession(sessionId: string, failureCode?: string, accessToken?: string) {
    return this.request<HintilyAccountState>('hintily-business', 'complete', 'POST', {
      session_id: sessionId, failure_code: failureCode || null,
    }, { accessToken });
  }
  async createCheckout(productCode: string) {
    const result = await this.request<{ checkout_url: string; session_id: string | null }>(
      'hintily-checkout', '', 'POST', { product_code: productCode },
      { retry: false },
    );
    if (!result.ok) return result;
    let checkout: URL;
    try { checkout = new URL(result.data.checkout_url); } catch {
      return { ok: false as const, error: 'invalid_checkout_url' };
    }
    if (checkout.protocol !== 'https:') return { ok: false as const, error: 'invalid_checkout_url' };
    await shell.openExternal(checkout.toString());
    return result;
  }
  getDeepgramConnection(sessionId: string): HintilyBusinessResult<{
    access_token: string;
    websocket_url: string;
    session_id: string;
  }> {
    const token = this.auth.getAccessToken();
    if (!token) return { ok: false, error: 'signed_out', status: 401 };
    const url = new URL(this.config.supabaseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    // Keep the trailing slash: the Deepgram SDK resolves its relative
    // `v1/listen` endpoint against this base URL.
    url.pathname = '/functions/v1/hintily-deepgram-stream/';
    url.search = '';
    return {
      ok: true,
      data: {
        access_token: token,
        websocket_url: url.toString(),
        session_id: sessionId,
      },
    };
  }
}
