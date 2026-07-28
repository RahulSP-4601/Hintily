import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HintilyBusinessService } from './HintilyBusinessService';

const AUTH_CHANGE_CLEANUP_TIMEOUT_MS = 2_000;
type ManagedAudioChannel = 'interviewer' | 'user';
const REQUIRED_AUDIO_CHANNELS: ReadonlySet<ManagedAudioChannel> =
  new Set<ManagedAudioChannel>(['interviewer', 'user']);

export class HintilyManagedSession extends EventEmitter {
  private static instance: HintilyManagedSession | null = null;
  private readonly business = HintilyBusinessService.getInstance();
  private sessionId: string | null = null;
  private connectedChannels = 0;
  private readonly readyChannels = new Set<ManagedAudioChannel>();
  private aiProviderReady = false;
  private authorizing: Promise<void> | null = null;
  private activating: Promise<void> | null = null;
  private activated = false;
  private cleanupToken: string | null = null;
  private stopping: Promise<void> | null = null;
  private readonly aiRequestControllers = new Set<AbortController>();
  private lifecycleGeneration = 0;

  static getInstance(): HintilyManagedSession {
    if (!this.instance) this.instance = new HintilyManagedSession();
    return this.instance;
  }

  get activeSessionId(): string | null {
    return this.activated ? this.sessionId : null;
  }

  get authorizedSessionId(): string | null {
    return this.sessionId;
  }

  async waitUntilActivated(): Promise<string> {
    if (this.activated && this.sessionId) return this.sessionId;
    const activation = this.activating;
    if (activation) await activation;
    if (this.activated && this.sessionId) return this.sessionId;
    throw new Error('managed_session_not_active');
  }

  registerAiRequest(controller: AbortController): () => void {
    this.aiRequestControllers.add(controller);
    return () => this.aiRequestControllers.delete(controller);
  }

  private cancelAiRequests(): void {
    for (const controller of this.aiRequestControllers) {
      try { controller.abort(); } catch { /* best effort */ }
    }
    this.aiRequestControllers.clear();
  }

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
    this.readyChannels.clear();
    this.connectedChannels = 0;
    this.aiProviderReady = false;
    const cleanupToken = this.business.captureAccessToken();
    const account = await this.business.getAccountState();
    if (!account.ok) {
      throw new Error('error' in account ? account.error : 'account_state_failed');
    }
    const clientSessionId =
      account.data.active_session?.client_session_id ?? randomUUID();
    const authorized = await this.business.authorizeSession(clientSessionId);
    if (!authorized.ok) throw new Error('error' in authorized ? authorized.error : 'authorization_failed');
    const aiReady = await this.business.checkManagedAiReady(authorized.data.session_id);
    if (!aiReady.ok || aiReady.data.ready !== true) {
      await this.business.completeSession(
        authorized.data.session_id,
        'ai_startup_failed',
        cleanupToken || undefined,
      ).catch((): void => undefined);
      throw new Error(!aiReady.ok && 'error' in aiReady ? aiReady.error : 'managed_ai_unavailable');
    }
    if (generation !== this.lifecycleGeneration) {
      await this.business.completeSession(
        authorized.data.session_id,
        'authorization_cancelled',
        cleanupToken || undefined,
      );
      return;
    }
    this.sessionId = authorized.data.session_id;
    this.activated = authorized.data.status === 'active';
    this.aiProviderReady = true;
    this.cleanupToken = cleanupToken || null;
  }

  async connection(channel: ManagedAudioChannel, leaseOwnerId: string): Promise<{
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

  channelConnected(channel: ManagedAudioChannel): void {
    this.readyChannels.add(channel);
    this.connectedChannels = this.readyChannels.size;
    this.maybeActivate();
  }

  private maybeActivate(): void {
    if (!this.activated
      && this.aiProviderReady
      && [...REQUIRED_AUDIO_CHANNELS].every(required => this.readyChannels.has(required))) {
      void this.activateAfterProviderReady();
    }
  }

  private async activateAfterProviderReady(): Promise<void> {
    if (this.activated || this.activating) return this.activating || Promise.resolve();
    const target = this.sessionId;
    const generation = this.lifecycleGeneration;
    if (!target) return;
    const attempt = (async () => {
      const result = await this.business.activateSession(target);
      if (!result.ok) {
        await this.business.completeSession(
          target,
          'stt_startup_failed',
          this.cleanupToken || undefined,
        ).catch((): void => undefined);
        if (this.sessionId === target) {
          this.sessionId = null;
          this.readyChannels.clear();
          this.connectedChannels = 0;
          this.aiProviderReady = false;
          this.cleanupToken = null;
        }
        this.emit('session-error', { code: 'activation_failed' });
        this.emit('terminate');
        return;
      }
      if (generation !== this.lifecycleGeneration || this.sessionId !== target) {
        await this.business.completeSession(
          target,
          'authorization_cancelled',
          this.cleanupToken || undefined,
        ).catch((): void => undefined);
        return;
      }
      this.activated = true;
    })();
    this.activating = attempt;
    try {
      await attempt;
    } finally {
      if (this.activating === attempt) this.activating = null;
    }
  }

  channelDisconnected(channel: ManagedAudioChannel): void {
    this.readyChannels.delete(channel);
    this.connectedChannels = this.readyChannels.size;
  }

  async channelStartupFailed(channel: ManagedAudioChannel): Promise<void> {
    this.readyChannels.delete(channel);
    this.connectedChannels = this.readyChannels.size;
    if (this.activated) {
      // A permanent provider failure after activation ends (and therefore
      // consumes) this single-use session. Leaving it active would strand the
      // allocation forever because no stream remains to send heartbeats.
      await this.stop('stt_connection_failed').catch((): void => undefined);
      this.emit('session-error', { code: 'stt_connection_failed', channel });
      this.emit('terminate');
      return;
    }
    const target = this.sessionId;
    if (!target) return;
    this.cancelAiRequests();
    await this.business.completeSession(
      target,
      'stt_startup_failed',
      this.cleanupToken || undefined,
    ).catch((): void => undefined);
    if (this.sessionId === target) {
      this.sessionId = null;
      this.readyChannels.clear();
      this.connectedChannels = 0;
      this.aiProviderReady = false;
      this.cleanupToken = null;
    }
    this.emit('session-error', { code: 'stt_startup_failed', channel });
    this.emit('terminate');
  }

  serverUsage(payload: {
    accepted_seconds?: number;
    remaining_seconds?: number | null;
    exhausted?: boolean;
  }): void {
    if (payload.exhausted) {
      this.cancelAiRequests();
      const target = this.sessionId;
      if (target) {
        void this.business.completeSession(
          target,
          'time_exhausted',
          this.cleanupToken || undefined,
        ).catch((): void => undefined);
      }
      this.sessionId = null;
      this.readyChannels.clear();
      this.connectedChannels = 0;
      this.activated = false;
      this.aiProviderReady = false;
      this.cleanupToken = null;
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
    this.cancelAiRequests();
    const cleanupToken = this.cleanupToken;
    this.stopping = (async () => {
      const completed = await this.business.completeSession(
        target,
        failureCode,
        cleanupToken || undefined,
      );
      if (!completed.ok) {
        throw new Error('error' in completed ? completed.error : 'session_completion_failed');
      }
      this.sessionId = null;
      this.readyChannels.clear();
      this.connectedChannels = 0;
      this.activated = false;
      this.aiProviderReady = false;
      this.cleanupToken = null;
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async stopForAuthChange(failureCode: string): Promise<void> {
    this.lifecycleGeneration++;
    this.cancelAiRequests();
    this.emit('terminate');
    const cleanup = this.stop(failureCode);
    this.sessionId = null;
    this.readyChannels.clear();
    this.connectedChannels = 0;
    this.activated = false;
    this.aiProviderReady = false;
    this.cleanupToken = null;
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
      this.readyChannels.clear();
      this.connectedChannels = 0;
      this.activated = false;
      this.aiProviderReady = false;
      this.cleanupToken = null;
    }
  }
}
