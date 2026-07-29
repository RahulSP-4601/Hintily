import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { HintilyBusinessService } from './HintilyBusinessService';

const AUTH_CHANGE_CLEANUP_TIMEOUT_MS = 2_000;
const ACTIVATION_WAIT_TIMEOUT_MS = 30_000;
const STREAM_READINESS_DELAYS_MS = [0, 75, 150, 300, 600, 1_000, 1_500, 2_000, 2_500];
type ManagedAudioChannel = 'interviewer' | 'user';
const REQUIRED_AUDIO_CHANNELS: ReadonlySet<ManagedAudioChannel> =
  new Set<ManagedAudioChannel>(['interviewer', 'user']);
type ActivationReadiness = {
  generation: number;
  promise: Promise<string>;
  resolve: (sessionId: string) => void;
  reject: (error: Error) => void;
};

export type HintilyManagedRuntimeStatus = {
  sessionId: string | null;
  surface: 'interview_helper' | 'meeting' | null;
  phase: 'idle' | 'authorizing' | 'connecting' | 'active' | 'stopping';
  aiReady: boolean;
  interviewerReady: boolean;
  userReady: boolean;
};

export class HintilyManagedSession extends EventEmitter {
  private static instance: HintilyManagedSession | null = null;
  private readonly business = HintilyBusinessService.getInstance();
  private sessionId: string | null = null;
  private connectedChannels = 0;
  private readonly readyChannels = new Set<ManagedAudioChannel>();
  private aiProviderReady = false;
  private authorizing: Promise<void> | null = null;
  private authorizingSurface: 'interview_helper' | 'meeting' | null = null;
  private activating: Promise<void> | null = null;
  private activationReadiness: ActivationReadiness | null = null;
  private serverActive = false;
  private activated = false;
  private cleanupToken: string | null = null;
  private postProcessingSessionId: string | null = null;
  private stopping: Promise<void> | null = null;
  private readonly aiRequestControllers = new Set<AbortController>();
  private lifecycleGeneration = 0;
  private surface: 'interview_helper' | 'meeting' | null = null;

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

  get activeSurface(): 'interview_helper' | 'meeting' | null {
    return this.activated ? this.surface : null;
  }

  get authorizedPostProcessingSessionId(): string | null {
    return this.postProcessingSessionId;
  }

  getRuntimeStatus(): HintilyManagedRuntimeStatus {
    const phase = this.stopping
      ? 'stopping'
      : this.authorizing
        ? 'authorizing'
        : this.activated
          ? 'active'
          : this.sessionId
            ? 'connecting'
            : 'idle';
    return {
      sessionId: this.sessionId,
      surface: this.surface,
      phase,
      aiReady: this.aiProviderReady,
      interviewerReady: this.readyChannels.has('interviewer'),
      userReady: this.readyChannels.has('user'),
    };
  }

  private beginActivationReadiness(generation: number): void {
    if (this.activationReadiness?.generation === generation) return;
    this.rejectActivationReadiness('managed_session_replaced');
    let resolve!: (sessionId: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // A provider can fail before an AI caller begins waiting. Keep the shared
    // rejection handled while preserving it for every later/current waiter.
    void promise.catch((): void => undefined);
    this.activationReadiness = { generation, promise, resolve, reject };
  }

  private resolveActivationReadiness(sessionId: string): void {
    const readiness = this.activationReadiness;
    if (!readiness || readiness.generation !== this.lifecycleGeneration) return;
    this.activationReadiness = null;
    readiness.resolve(sessionId);
  }

  private notifyActivated(sessionId: string): void {
    this.resolveActivationReadiness(sessionId);
    this.emit('activated', { sessionId, surface: this.surface });
  }

  private rejectActivationReadiness(code: string): void {
    const readiness = this.activationReadiness;
    if (!readiness) return;
    this.activationReadiness = null;
    readiness.reject(new Error(code));
  }

  async waitUntilActivated(purpose: 'live' | 'post_meeting' = 'live'): Promise<string> {
    if (purpose === 'post_meeting' && this.postProcessingSessionId) {
      return this.postProcessingSessionId;
    }
    if (this.activated && this.sessionId) return this.sessionId;
    const authorization = this.authorizing;
    if (authorization) await authorization;
    if (this.activated && this.sessionId) return this.sessionId;
    const readiness = this.activationReadiness;
    if (!this.sessionId || !readiness
      || readiness.generation !== this.lifecycleGeneration) {
      throw new Error('managed_session_not_active');
    }
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('managed_session_activation_timeout')),
        ACTIVATION_WAIT_TIMEOUT_MS,
      );
      readiness.promise.then(
        sessionId => {
          clearTimeout(timeout);
          resolve(sessionId);
        },
        error => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
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

  async authorize(surface: 'interview_helper' | 'meeting'): Promise<void> {
    if (this.sessionId) {
      if (this.surface !== surface) throw new Error('managed_session_surface_mismatch');
      return;
    }
    if (this.authorizing) {
      if (this.authorizingSurface !== surface) {
        throw new Error('managed_session_surface_mismatch');
      }
      return this.authorizing;
    }
    const generation = this.lifecycleGeneration;
    this.beginActivationReadiness(generation);
    const attempt = this.authorizeOnce(generation, surface);
    this.authorizing = attempt;
    this.authorizingSurface = surface;
    try {
      await attempt;
    } catch (error) {
      this.rejectActivationReadiness(
        error instanceof Error ? error.message : 'authorization_failed',
      );
      throw error;
    } finally {
      if (this.authorizing === attempt) {
        this.authorizing = null;
        this.authorizingSurface = null;
      }
    }
  }

  private async authorizeOnce(
    generation: number,
    surface: 'interview_helper' | 'meeting',
  ): Promise<void> {
    this.readyChannels.clear();
    this.connectedChannels = 0;
    this.aiProviderReady = false;
    this.postProcessingSessionId = null;
    const cleanupToken = this.business.captureAccessToken();
    const account = await this.business.getAccountState();
    if (!account.ok) {
      throw new Error('error' in account ? account.error : 'account_state_failed');
    }
    const existingSession = account.data.active_session;
    let clientSessionId = existingSession?.client_session_id ?? randomUUID();
    let reconciledExistingSession = false;
    const reconcileExistingSession = async (): Promise<void> => {
      if (!existingSession || reconciledExistingSession) return;
      const completed = await this.business.completeSession(
        existingSession.id,
        'surface_changed',
        cleanupToken || undefined,
      );
      if (!completed.ok) {
        throw new Error('error' in completed ? completed.error : 'session_completion_failed');
      }
      reconciledExistingSession = true;
      clientSessionId = randomUUID();
    };

    // A crash can leave the previous surface's server session active while
    // desktop memory is empty. Settle that session before requesting access
    // for a different product surface.
    if (existingSession?.surface && existingSession.surface !== surface) {
      await reconcileExistingSession();
    }

    let authorized = await this.business.authorizeSession(clientSessionId, surface);
    // Older account-state responses may not include `surface`. The authorize
    // RPC remains authoritative, so reconcile and retry once when it reports
    // that the crash-left session belongs to the other surface.
    if (!authorized.ok
      && 'error' in authorized
      && authorized.error === 'session_surface_mismatch'
      && existingSession
      && !reconciledExistingSession) {
      await reconcileExistingSession();
      authorized = await this.business.authorizeSession(clientSessionId, surface);
    }
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
    this.surface = surface;
    // A server-active session restored after a crash is authorized, but this
    // desktop generation is not ready for AI until both of its replacement
    // Deepgram channels have opened and acquired live leases.
    this.serverActive = authorized.data.status === 'active';
    this.activated = false;
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

  async waitForChannelReady(channel: ManagedAudioChannel): Promise<void> {
    const target = this.sessionId;
    const generation = this.lifecycleGeneration;
    if (!target) throw new Error('managed_session_not_authorized');
    for (const delay of STREAM_READINESS_DELAYS_MS) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (generation !== this.lifecycleGeneration || this.sessionId !== target) {
        throw new Error('managed_session_cancelled');
      }
      const result = await this.business.checkStreamChannelReady(target, channel);
      if (result.ok && result.data.ready) return;
      if ('error' in result && (result.status === 401 || result.error === 'signed_out')) {
        throw new Error('signed_out');
      }
    }
    throw new Error('stt_provider_not_ready');
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
      if (this.serverActive) {
        const target = this.sessionId;
        if (!target) return;
        this.activated = true;
        this.notifyActivated(target);
        return;
      }
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
        this.rejectActivationReadiness('managed_session_activation_failed');
        if (this.sessionId === target) {
          this.sessionId = null;
          this.readyChannels.clear();
          this.connectedChannels = 0;
          this.aiProviderReady = false;
          this.cleanupToken = null;
          this.surface = null;
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
      this.serverActive = true;
      this.activated = true;
      this.notifyActivated(target);
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

  async beginPostProcessing(): Promise<boolean> {
    const target = this.activeSessionId;
    if (!target || this.surface !== 'meeting') return false;
    if (![...REQUIRED_AUDIO_CHANNELS].every(channel => this.readyChannels.has(channel))) {
      throw new Error('managed_streams_not_ready_for_post_processing');
    }
    const result = await this.business.beginPostProcessing(target);
    if (!result.ok) {
      throw new Error('error' in result ? result.error : 'post_processing_authorization_failed');
    }
    this.cancelAiRequests();
    this.postProcessingSessionId = target;
    return true;
  }

  async channelStartupFailed(channel: ManagedAudioChannel): Promise<void> {
    this.readyChannels.delete(channel);
    this.connectedChannels = this.readyChannels.size;
    if (this.serverActive) {
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
    this.rejectActivationReadiness('managed_session_stt_startup_failed');
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
      this.surface = null;
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
      const target = this.sessionId;
      // Both Deepgram channels can deliver the same terminal usage state. The
      // first delivery clears the live ID but deliberately retains the
      // post-processing ID; every later delivery is therefore already handled.
      if (!target && this.postProcessingSessionId) return;
      const preservePostProcessing = Boolean(
        target && this.postProcessingSessionId === target,
      );
      // A final relay meter can legitimately exhaust the allocation at the
      // exact Stop boundary. Preserve already-authorized post-meeting work;
      // the server grant remains bounded even though live use is over.
      if (!preservePostProcessing) {
        this.cancelAiRequests();
      }
      this.rejectActivationReadiness('managed_session_time_exhausted');
      if (target && !preservePostProcessing) {
        void this.business.completeSession(
          target,
          'time_exhausted',
          this.cleanupToken || undefined,
        ).catch((): void => undefined);
      }
      this.sessionId = null;
      this.readyChannels.clear();
      this.connectedChannels = 0;
      this.serverActive = false;
      this.activated = false;
      this.aiProviderReady = false;
      // The post-summary stop still needs the captured token to atomically
      // revoke the bounded grant and finalize the already-exhausted session.
      if (!preservePostProcessing) this.cleanupToken = null;
      this.surface = null;
      this.emit('exhausted');
      return;
    }
    const remaining = payload.remaining_seconds;
    const accepted = payload.accepted_seconds || 0;
    if (remaining != null &&
      [600, 300, 60].some(limit =>
        remaining <= limit && remaining + accepted > limit)) {
      this.emit('warning', { remainingSeconds: remaining });
    }
  }

  async stop(failureCode?: string): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.authorizing) {
      await this.authorizing.catch((): void => undefined);
    }
    const target = this.sessionId ?? this.postProcessingSessionId;
    if (!target) return;
    this.cancelAiRequests();
    this.rejectActivationReadiness('managed_session_stopped');
    const cleanupToken = this.cleanupToken;
    this.stopping = (async () => {
      // The business endpoint atomically revokes any post-processing grant,
      // releases AI leases, and completes the paid session. Retain every local
      // retry handle until the backend confirms that transaction committed.
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
      this.serverActive = false;
      this.activated = false;
      this.aiProviderReady = false;
      this.cleanupToken = null;
      this.postProcessingSessionId = null;
      this.surface = null;
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }

  async stopForAuthChange(failureCode: string): Promise<void> {
    this.lifecycleGeneration++;
    this.cancelAiRequests();
    this.rejectActivationReadiness('managed_session_auth_changed');
    this.emit('terminate');
    const cleanup = this.stop(failureCode);
    this.sessionId = null;
    this.readyChannels.clear();
    this.connectedChannels = 0;
    this.serverActive = false;
    this.activated = false;
    this.aiProviderReady = false;
    this.cleanupToken = null;
    this.postProcessingSessionId = null;
    this.surface = null;
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
      this.serverActive = false;
      this.activated = false;
      this.aiProviderReady = false;
      this.cleanupToken = null;
      this.postProcessingSessionId = null;
      this.surface = null;
    }
  }
}
