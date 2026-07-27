import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HintilyBusinessService } from './HintilyBusinessService';

const AUTH_CHANGE_CLEANUP_TIMEOUT_MS = 2_000;

export class HintilyManagedSession extends EventEmitter {
  private static instance: HintilyManagedSession | null = null;
  private readonly business = HintilyBusinessService.getInstance();
  private sessionId: string | null = null;
  private connectedChannels = 0;
  private authorizing: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private lifecycleGeneration = 0;

  static getInstance(): HintilyManagedSession {
    if (!this.instance) this.instance = new HintilyManagedSession();
    return this.instance;
  }

  get activeSessionId(): string | null { return this.sessionId; }

  async authorize(): Promise<void> {
    if (this.sessionId) return;
    if (this.authorizing) return this.authorizing;
    const generation = this.lifecycleGeneration;
    const attempt = this.authorizeOnce(generation);
    this.authorizing = attempt;
    try {
      await attempt;
    } finally {
      if (this.authorizing === attempt) this.authorizing = null;
    }
  }

  private async authorizeOnce(generation: number): Promise<void> {
    const cleanupToken = this.business.captureAccessToken();
    const account = await this.business.getAccountState();
    if (!account.ok) {
      throw new Error('error' in account ? account.error : 'account_state_failed');
    }
    const clientSessionId =
      account.data.active_session?.client_session_id ?? randomUUID();
    const authorized = await this.business.authorizeSession(clientSessionId);
    if (!authorized.ok) throw new Error('error' in authorized ? authorized.error : 'authorization_failed');
    if (generation !== this.lifecycleGeneration) {
      await this.business.completeSession(
        authorized.data.session_id,
        'authorization_cancelled',
        cleanupToken || undefined,
      );
      return;
    }
    const activated = await this.business.activateSession(authorized.data.session_id);
    if (!activated.ok) {
      await this.business.completeSession(
        authorized.data.session_id,
        'stt_startup_failed',
        cleanupToken || undefined,
      );
      throw new Error('error' in activated ? activated.error : 'activation_failed');
    }
    if (generation !== this.lifecycleGeneration) {
      void this.business.completeSession(
        authorized.data.session_id,
        'authorization_cancelled',
        cleanupToken || undefined,
      );
      return;
    }
    this.sessionId = authorized.data.session_id;
  }

  async connection(channel: 'interviewer' | 'user', leaseOwnerId: string): Promise<{
    token: string;
    websocketUrl: string;
    sessionId: string;
    channel: 'interviewer' | 'user';
    leaseOwnerId: string;
  }> {
    if (!this.sessionId) throw new Error('managed_session_not_authorized');
    const result = this.business.getDeepgramConnection(this.sessionId);
    if (!result.ok) throw new Error('error' in result ? result.error : 'deepgram_authorization_failed');
    return {
      token: result.data.access_token,
      websocketUrl: result.data.websocket_url,
      sessionId: result.data.session_id,
      channel,
      leaseOwnerId,
    };
  }

  channelConnected(): void {
    this.connectedChannels++;
  }

  channelDisconnected(): void {
    this.connectedChannels = Math.max(0, this.connectedChannels - 1);
  }

  serverUsage(payload: {
    accepted_seconds?: number;
    remaining_seconds?: number | null;
    exhausted?: boolean;
  }): void {
    if (payload.exhausted) {
      this.sessionId = null;
      this.connectedChannels = 0;
      this.emit('exhausted');
      return;
    }
    const remaining = payload.remaining_seconds;
    const accepted = payload.accepted_seconds || 0;
    if (remaining != null &&
      [300, 120, 60].some(limit =>
        remaining <= limit && remaining + accepted > limit)) {
      this.emit('warning', { remainingSeconds: remaining });
    }
  }

  async stop(failureCode?: string): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.authorizing) {
      await this.authorizing.catch((): void => undefined);
    }
    const target = this.sessionId;
    if (!target) return;
    this.stopping = (async () => {
      const completed = await this.business.completeSession(target, failureCode);
      if (!completed.ok) {
        throw new Error('error' in completed ? completed.error : 'session_completion_failed');
      }
      this.sessionId = null;
      this.connectedChannels = 0;
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async stopForAuthChange(failureCode: string): Promise<void> {
    this.lifecycleGeneration++;
    this.emit('terminate');
    const cleanup = this.stop(failureCode);
    this.sessionId = null;
    this.connectedChannels = 0;
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        cleanup.catch((): void => undefined),
        new Promise<void>(resolve => {
          timeout = setTimeout(resolve, AUTH_CHANGE_CLEANUP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.sessionId = null;
      this.connectedChannels = 0;
    }
  }
}
