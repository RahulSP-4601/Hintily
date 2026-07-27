import { BrowserWindow, shell } from 'electron';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { createClient, type SupabaseClient, type Session, type User } from '@supabase/supabase-js';
import keytar from 'keytar';
import { assertHintilyAuthConfigured, getHintilyConfig, type HintilyConfig } from '../../config/hintily';
import type { HintilyAuthResult, HintilyAuthStatus, HintilyUser } from './types';

const KEYCHAIN_SERVICE = 'com.hintily.desktop.auth';
const KEYCHAIN_ACCOUNT = 'supabase-session';
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

interface OAuthCallbackListener {
  ready: Promise<void>;
  session: Promise<Session>;
}

interface OAuthCallbackOutcome {
  session: Session | null;
  error: unknown | null;
}

const safeMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error || 'Unknown authentication error');
  if (/refresh.?token/i.test(message)) return 'Your session expired. Please sign in again.';
  if (/network|fetch|ENOTFOUND|ECONN/i.test(message)) return 'Unable to reach Hintily account services.';
  return message.slice(0, 300);
};

const isTerminalRefreshError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : 0;
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  if (['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'user_not_found'].includes(code)) {
    return true;
  }
  return status >= 400 && status < 500 && status !== 408 && status !== 429
    && /refresh|session|jwt|token|user/i.test(`${code} ${message}`);
};

const toUser = (user: User): HintilyUser => ({
  id: user.id,
  email: user.email || null,
  displayName:
    (typeof user.user_metadata?.full_name === 'string' && user.user_metadata.full_name) ||
    (typeof user.user_metadata?.name === 'string' && user.user_metadata.name) ||
    null,
  avatarUrl:
    (typeof user.user_metadata?.avatar_url === 'string' && user.user_metadata.avatar_url) ||
    (typeof user.user_metadata?.picture === 'string' && user.user_metadata.picture) ||
    null,
});

export class HintilyAuthService extends EventEmitter {
  private static instance: HintilyAuthService | null = null;
  private readonly config: HintilyConfig;
  private client: SupabaseClient | null = null;
  private session: Session | null = null;
  private status: HintilyAuthStatus;
  private callbackServer: Server | null = null;
  private callbackTimer: NodeJS.Timeout | null = null;
  private signInPromise: Promise<HintilyAuthResult> | null = null;

  static getInstance(): HintilyAuthService {
    if (!this.instance) this.instance = new HintilyAuthService();
    return this.instance;
  }

  private constructor() {
    super();
    this.config = getHintilyConfig();
    this.status = this.config.configured
      ? { state: 'signed_out', user: null }
      : {
          state: 'unconfigured',
          user: null,
          error: `Missing ${this.config.missing.join(', ')}`,
        };
  }

  private getClient(): SupabaseClient {
    if (this.client) return this.client;
    const config = assertHintilyAuthConfigured();
    this.client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        // Keep the desktop session usable beyond the initial JWT lifetime.
        // Rotated refresh tokens are persisted by the TOKEN_REFRESHED listener
        // below; Supabase's own browser storage remains disabled.
        autoRefreshToken: true,
        persistSession: false,
        detectSessionInUrl: false,
        flowType: 'pkce',
      },
      global: {
        headers: { 'X-Client-Info': 'hintily-desktop' },
      },
    });
    this.client.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session) {
        void this.acceptSession(session).catch((error) => {
          console.error('[HintilyAuth] Could not persist refreshed session:', safeMessage(error));
        });
      } else if (event === 'SIGNED_OUT' && this.session) {
        void this.clearLocalSession();
      }
    });
    return this.client;
  }

  private setStatus(status: HintilyAuthStatus): void {
    this.status = status;
    this.emit('changed', status);
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('hintily-auth:changed', status);
    }
  }

  getStatus(): HintilyAuthStatus {
    return this.status;
  }

  getAccessToken(): string | null {
    return this.session?.access_token || null;
  }

  async initialize(): Promise<HintilyAuthStatus> {
    if (!this.config.configured) return this.status;
    try {
      const serialized = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
      if (!serialized) return this.status;
      const stored = JSON.parse(serialized) as { access_token?: string; refresh_token?: string };
      if (!stored.access_token || !stored.refresh_token) {
        await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        return this.status;
      }
      const { data, error } = await this.getClient().auth.setSession({
        access_token: stored.access_token,
        refresh_token: stored.refresh_token,
      });
      if (error || !data.session) throw error || new Error('Stored session is invalid');
      await this.acceptSession(data.session);
    } catch (error) {
      await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).catch(() => false);
      this.session = null;
      this.setStatus({ state: 'signed_out', user: null });
      console.warn('[HintilyAuth] Stored session could not be restored:', safeMessage(error));
    }
    return this.status;
  }

  async signInWithGoogle(): Promise<HintilyAuthResult> {
    if (this.signInPromise) return this.signInPromise;
    this.signInPromise = this.performGoogleSignIn().finally(() => {
      this.signInPromise = null;
    });
    return this.signInPromise;
  }

  private async performGoogleSignIn(): Promise<HintilyAuthResult> {
    try {
      assertHintilyAuthConfigured();
      this.setStatus({ state: 'signing_in', user: null });
      const callback = this.listenForCallback();
      // Attach a rejection handler immediately. A busy callback port can fail
      // before the Supabase URL request completes, and must never become an
      // unhandled rejection in the Electron main process.
      const callbackOutcome: Promise<OAuthCallbackOutcome> = callback.session.then(
        (session): OAuthCallbackOutcome => ({ session, error: null }),
        (error: unknown): OAuthCallbackOutcome => ({ session: null, error }),
      );
      await callback.ready;
      const { data, error } = await this.getClient().auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: this.config.oauthCallbackUrl,
          skipBrowserRedirect: true,
          queryParams: { access_type: 'offline', prompt: 'select_account' },
        },
      });
      if (error || !data.url) throw error || new Error('Google sign-in URL was not returned');
      await shell.openExternal(data.url);
      const outcome = await callbackOutcome;
      if (outcome.error || !outcome.session) throw outcome.error || new Error('OAuth callback failed');
      await this.acceptSession(outcome.session);
      return { ok: true, status: this.status };
    } catch (error) {
      this.stopCallbackServer();
      const message = safeMessage(error);
      this.setStatus({ state: 'error', user: null, error: message });
      return { ok: false, status: this.status, error: message };
    }
  }

  private listenForCallback(): OAuthCallbackListener {
    this.stopCallbackServer();
    const callback = new URL(this.config.oauthCallbackUrl);
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const session = new Promise<Session>((resolve, reject) => {
      let settled = false;
      let listening = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.stopCallbackServer();
        fn();
      };
      this.callbackServer = createServer(async (request, response) => {
        try {
          const requestUrl = new URL(request.url || '/', this.config.oauthCallbackUrl);
          if (requestUrl.pathname !== callback.pathname) {
            response.writeHead(404).end('Not found');
            return;
          }
          const oauthError = requestUrl.searchParams.get('error_description') || requestUrl.searchParams.get('error');
          if (oauthError) {
            response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end('<h2>Hintily sign-in was cancelled.</h2><p>You can close this window.</p>');
            finish(() => reject(new Error(oauthError)));
            return;
          }
          const code = requestUrl.searchParams.get('code');
          if (!code) throw new Error('OAuth callback did not include an authorization code');
          const { data, error } = await this.getClient().auth.exchangeCodeForSession(code);
          if (error || !data.session) throw error || new Error('Unable to create a Hintily session');
          response.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          response.end('<h2>Signed in to Hintily.</h2><p>You can close this window and return to the app.</p><script>setTimeout(()=>window.close(),700)</script>');
          finish(() => resolve(data.session));
        } catch (error) {
          response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end('<h2>Hintily could not complete sign-in.</h2><p>Return to the app and try again.</p>');
          finish(() => reject(error));
        }
      });
      this.callbackServer.once('listening', () => {
        listening = true;
        resolveReady();
      });
      this.callbackServer.once('error', (error) => {
        if (!listening) rejectReady(error);
        finish(() => reject(error));
      });
      this.callbackServer.listen(Number(callback.port), callback.hostname);
      this.callbackTimer = setTimeout(
        () => finish(() => reject(new Error('Google sign-in timed out'))),
        CALLBACK_TIMEOUT_MS,
      );
    });
    return { ready, session };
  }

  private async acceptSession(session: Session): Promise<void> {
    this.session = session;
    await keytar.setPassword(
      KEYCHAIN_SERVICE,
      KEYCHAIN_ACCOUNT,
      JSON.stringify({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
      }),
    );
    this.setStatus({ state: 'signed_in', user: toUser(session.user) });
  }

  private async clearLocalSession(): Promise<void> {
    this.session = null;
    await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).catch(() => false);
    this.setStatus({ state: 'signed_out', user: null });
  }

  async refresh(): Promise<HintilyAuthResult> {
    if (!this.session?.refresh_token) {
      this.setStatus({ state: 'signed_out', user: null });
      return { ok: false, status: this.status, error: 'Not signed in' };
    }
    try {
      const { data, error } = await this.getClient().auth.refreshSession({
        refresh_token: this.session.refresh_token,
      });
      if (error || !data.session) throw error || new Error('Unable to refresh session');
      await this.acceptSession(data.session);
      return { ok: true, status: this.status };
    } catch (error) {
      const message = safeMessage(error);
      if (isTerminalRefreshError(error)) {
        await this.clearLocalSession();
      }
      return { ok: false, status: this.status, error: message };
    }
  }

  async signOut(): Promise<HintilyAuthResult> {
    this.stopCallbackServer();
    try {
      // Revoke all refresh tokens for this user when Supabase is reachable.
      // Local cleanup below remains unconditional for offline sign-out.
      if (this.client && this.session) await this.client.auth.signOut({ scope: 'global' });
    } catch {
      // Local cleanup must still finish when the network is unavailable.
    }
    await this.clearLocalSession();
    return { ok: true, status: this.status };
  }

  async deleteAccount(): Promise<HintilyAuthResult> {
    if (!this.session) return { ok: false, status: this.status, error: 'Not signed in' };
    const response = await fetch(`${this.config.supabaseUrl}/functions/v1/hintily-account`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.session.access_token}`,
        apikey: this.config.supabaseAnonKey,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        status: this.status,
        error: body.slice(0, 200) || `Account deletion failed (${response.status})`,
      };
    }
    return this.signOut();
  }

  private stopCallbackServer(): void {
    if (this.callbackTimer) clearTimeout(this.callbackTimer);
    this.callbackTimer = null;
    this.callbackServer?.close();
    this.callbackServer = null;
  }
}
