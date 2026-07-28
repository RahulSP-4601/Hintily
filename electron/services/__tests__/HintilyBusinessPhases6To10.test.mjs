import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('unlimited products have exact prices, periods, refund and dispute handling', () => {
  const dodo = read('supabase/functions/_shared/dodo.ts');
  const webhook = read('supabase/functions/hintily-dodo-webhook/index.ts');
  const processing = read('supabase/migrations/202607270004_hintily_dodo_processing.sql');
  const migration = read('supabase/migrations/202607280003_hintily_phases_6_to_10.sql');
  for (const expected of [
    /unlimited_monthly[\s\S]*amountMinor: 339_900/,
    /unlimited_quarterly[\s\S]*amountMinor: 749_700/,
    /unlimited_yearly[\s\S]*amountMinor: 2_518_800/,
    /unlimited_lifetime[\s\S]*amountMinor: 3_500_000/,
  ]) assert.match(dodo, expected);
  assert.match(webhook, /addUtcMonths[\s\S]*interval === 'year' \? 12[\s\S]*interval === 'quarter' \? 3 : 1/);
  assert.match(webhook, /interval === 'lifetime'\) endsAt = null/);
  assert.match(webhook, /hintily_apply_dodo_partial_refund/);
  assert.match(webhook, /\.select\('user_id,product_code,metadata'\)/);
  assert.match(
    webhook,
    /storedMetadata\.dodo_subscription_id[\s\S]*subscriptionId = storedSubscriptionId/,
  );
  assert.match(migration, /partial refund is audit-only and does not revoke/);
  assert.match(migration, /prior_refunded :=[\s\S]*cumulative_refunded := prior_refunded \+ refund_delta_minor/);
  assert.match(processing, /subscription\.(cancelled|expired|failed|on_hold)/);
  assert.match(processing, /dispute\.(opened|accepted|lost)/);
  assert.match(processing, /dispute\.won', 'dispute\.cancelled/);
});

test('checkout and webhook access changes are backend-authenticated and idempotent', () => {
  const checkout = read('supabase/functions/hintily-checkout/index.ts');
  const webhook = read('supabase/functions/hintily-dodo-webhook/index.ts');
  const processing = read('supabase/migrations/202607270004_hintily_dodo_processing.sql');
  const account = read('src/components/settings/HintilyAccountSettings.tsx');
  assert.match(checkout, /authenticatedClient\(request\)/);
  assert.match(checkout, /hintily_user_id: auth\.user\.id/);
  assert.match(webhook, /verifyDodoSignature\(raw, id, timestamp, signature, secret\)/);
  assert.match(processing, /on conflict \(provider, provider_event_id\)/);
  assert.match(processing, /stale_provider_event/);
  assert.match(account, /Access will update after Dodo confirms payment/);
  assert.match(account, /access_revision/);
});

test('managed AI enforces session access, real streaming, bounded failover and private audit', () => {
  const ai = read('supabase/functions/hintily-ai/index.ts');
  const migration = read('supabase/migrations/202607280003_hintily_phases_6_to_10.sql');
  const enforcement = read('supabase/migrations/202607280002_hintily_ai_enforcement.sql');
  const businessService = read('electron/services/business/HintilyBusinessService.ts');
  const llm = read('electron/LLMHelper.ts');
  assert.match(ai, /authenticatedClient\(request\)/);
  assert.match(ai, /\.eq\('user_id', auth\.user\.id\)/);
  assert.match(ai, /session\.status !== 'active'/);
  assert.match(ai, /const managedProviders[\s\S]*return providers\.slice\(0, 2\)/);
  assert.match(ai, /PROVIDER_TOTAL_TIMEOUT_MS = 40_000/);
  assert.match(ai, /PROVIDER_ATTEMPT_START_TIMEOUT_MS = 18_000/);
  assert.match(ai, /AbortSignal\.any\(\[deadlineController\.signal, attemptController\.signal\]\)/);
  assert.match(enforcement, /now\(\) \+ interval '60 seconds'/);
  assert.match(
    businessService,
    /checkManagedAiReady[\s\S]*retry: false, timeoutMs: 20_000/,
  );
  assert.match(llm, /AbortSignal\.timeout\(50_000\)/);
  assert.match(ai, /READINESS_TIMEOUT_MS = 8_000/);
  assert.match(ai, /max_completion_tokens: 2/);
  assert.match(ai, /maxOutputTokens: 2/);
  assert.match(ai, /action !== 'chat' && action !== 'stream'/);
  assert.match(ai, /text\/event-stream/);
  assert.match(ai, /let upstreamDecoder = new TextDecoder\(\)/);
  assert.match(ai, /upstreamDecoder\.decode\(value, \{ stream: true \}\)/);
  assert.match(
    ai,
    /providerOutputCharacters === 0[\s\S]*switchToFallback\(\)[\s\S]*managed_ai_empty_response[\s\S]*finish\('failed'\)/,
  );
  assert.match(ai, /payload\.error[\s\S]*managed_ai_provider_stream_error/);
  assert.match(ai, /providerOpener\.openNext\(\)/);
  assert.match(ai, /hintily_ai_begin_request/);
  assert.match(ai, /hintily_ai_record_usage/);
  assert.doesNotMatch(ai, /console\.(log|error)\([^)]*(userText|system|content)/);
  assert.match(migration, /create table if not exists public\.hintily_ai_usage_events/);
  assert.match(migration, /revoke all on public\.hintily_ai_usage_events/);
  assert.match(llm, /functions\/v1\/hintily-ai\/stream/);
  assert.match(llm, /waitUntilActivated\(\)/);
  assert.match(
    llm,
    /let reader: ReadableStreamDefaultReader<Uint8Array> \| null = null[\s\S]*finally \{[\s\S]*requestController\.abort\(\)[\s\S]*await reader\.cancel\(\)/,
  );
  const meetingSummary = llm.slice(
    llm.indexOf('public async generateMeetingSummary'),
    llm.indexOf('public async switchToOllama'),
  );
  assert.match(meetingSummary, /useHintilyManaged[\s\S]*generateWithHintilyManaged/);
  assert.ok(
    meetingSummary.indexOf('generateWithHintilyManaged') < meetingSummary.indexOf('this.customProvider'),
    'managed meeting summaries must run before every legacy provider branch',
  );
});

test('one surface-bound session owns AI, Deepgram and the authoritative clock', () => {
  const managed = read('electron/services/business/HintilyManagedSession.ts');
  const business = read('supabase/functions/hintily-business/index.ts');
  const deepgram = read('supabase/functions/hintily-deepgram-stream/index.ts');
  const migration = read('supabase/migrations/202607280003_hintily_phases_6_to_10.sql');
  const main = read('electron/main.ts');
  assert.match(managed, /authorize\(surface: 'interview_helper' \| 'meeting'\)/);
  assert.match(
    managed,
    /if \(this\.authorizing\) \{[\s\S]*this\.authorizingSurface !== surface[\s\S]*managed_session_surface_mismatch/,
  );
  assert.match(managed, /this\.authorizingSurface = surface/);
  assert.match(
    managed,
    /existingSession\?\.surface && existingSession\.surface !== surface[\s\S]*reconcileExistingSession\(\)/,
  );
  assert.match(
    managed,
    /authorized\.error === 'session_surface_mismatch'[\s\S]*reconcileExistingSession\(\)[\s\S]*authorizeSession\(clientSessionId, surface\)/,
  );
  assert.match(managed, /completeSession\([\s\S]*'surface_changed'/);
  assert.match(business, /requested_surface: surface/);
  assert.match(business, /session_surface_mismatch/);
  assert.match(deepgram, /\.in\('status', \['pending', 'active'\]\)/);
  assert.match(migration, /target\.status = 'pending'[\s\S]*'accepted_seconds', 0/);
  assert.match(migration, /revoke all on function public\.hintily_session_heartbeat/);
  assert.match(migration, /surface = requested_surface/);
  assert.match(migration, /session_surface_mismatch/);
  assert.match(migration, /target\.ai_ready_at is null[\s\S]*ai_provider_not_ready/);
  assert.match(migration, /count\(distinct channel\)[\s\S]*ready_channels <> 2/);
  assert.match(migration, /create or replace function public\.hintily_stream_channel_ready/);
  assert.match(managed, /waitForChannelReady\(channel: ManagedAudioChannel\)/);
  assert.match(
    managed,
    /waitUntilActivated\([^)]*\)[\s\S]*activationReadiness[\s\S]*ACTIVATION_WAIT_TIMEOUT_MS/,
  );
  assert.match(
    managed,
    /this\.activated = true;\s*this\.notifyActivated\(target\)/,
  );
  assert.match(
    managed,
    /notifyActivated\(sessionId: string\)[\s\S]*resolveActivationReadiness\(sessionId\)[\s\S]*emit\('activated'/,
  );
  assert.match(
    managed,
    /channelStartupFailed[\s\S]*rejectActivationReadiness\('managed_session_stt_startup_failed'\)/,
  );
  assert.match(main, /waitForChannelReady\(speaker\)[\s\S]*managed\.channelConnected\(speaker\)/);
  assert.match(main, /waitForMeetingProcessing\(\)[\s\S]*releaseStt\(\)/);
  assert.match(main, /finally \{[\s\S]*releaseStt\(\)[\s\S]*clearTranscriptThrottle/);
});

test('unique partial refunds accumulate safely even when delivery is out of order', () => {
  const migration = read('supabase/migrations/202607280003_hintily_phases_6_to_10.sql');
  const webhook = read('supabase/functions/hintily-dodo-webhook/index.ts');
  assert.doesNotMatch(
    migration,
    /purchase_row\.provider_event_at > event_occurred_at[\s\S]{0,500}'stale'/,
  );
  assert.match(migration, /cumulative_refunded := prior_refunded \+ refund_delta_minor/);
  assert.match(migration, /effective_event_at := greatest/);
  assert.match(migration, /'full_refund', true,[\s\S]*'effective_event_at'/);
  assert.match(migration, /provider_event_at = effective_event_at/);
  assert.match(webhook, /appliedEventTimestamp = partialResult\.effective_event_at/);
  assert.match(webhook, /event_occurred_at: appliedEventTimestamp/);
});

test('refund revocation requires a valid amount and a reconciled original purchase', () => {
  const webhook = read('supabase/functions/hintily-dodo-webhook/index.ts');
  const refundStart = webhook.indexOf("if (eventType === 'refund.succeeded')");
  const terminalStart = webhook.indexOf('const terminal =', refundStart);
  assert.ok(refundStart >= 0 && terminalStart > refundStart);
  const refundBlock = webhook.slice(refundStart, terminalStart);
  assert.match(refundBlock, /refund_payment_id_required/);
  assert.match(refundBlock, /Number\.isSafeInteger\(refundedAmount\)[\s\S]*invalid_refund_amount/);
  assert.match(refundBlock, /originalPurchaseError[\s\S]*webhook_processing_failed/);
  assert.match(refundBlock, /Number\.isSafeInteger\(originalAmount\)[\s\S]*purchase_reconciliation_required/);
  assert.match(refundBlock, /if \(refundedAmount < originalAmount\)[\s\S]*hintily_apply_dodo_partial_refund/);
});

test('meeting cleanup is serialized before reuse and STT switching preserves its surface', () => {
  const ipc = read('electron/ipcHandlers.ts');
  const start = ipc.indexOf("safeHandle('start-meeting'");
  const end = ipc.indexOf("safeHandle('end-meeting'", start);
  assert.ok(start >= 0 && end > start);
  const startBlock = ipc.slice(start, end);
  assert.ok(
    startBlock.indexOf('await waitForHintilyMeetingCleanup()')
      < startBlock.indexOf('await managedSession.authorize(surface)'),
    'the previous teardown and managed stop must finish before authorization',
  );
  assert.match(startBlock, /authorizedSessionId[\s\S]*stop\('stale_meeting_cleanup'\)/);
  assert.match(ipc, /beginHintilyMeetingCleanup[\s\S]*waitForMeetingTeardown\(\)[\s\S]*managedSession\.stop/);
  const providerStart = ipc.indexOf("'set-stt-provider'");
  const providerEnd = ipc.indexOf('// ==========================================', providerStart + 20);
  const providerBlock = ipc.slice(providerStart, providerEnd);
  assert.match(
    providerBlock,
    /managedSession\.authorize\(activeHintilySurface \?\? resolveHintilySurface\(\)\)/,
  );
  assert.doesNotMatch(providerBlock, /managedSession\.authorize\('meeting'\)/);
});

test('managed recovery is account-owned and waits for a stream-ready Meeting surface', () => {
  const managed = read('electron/services/business/HintilyManagedSession.ts');
  const llm = read('electron/LLMHelper.ts');
  const persistence = read('electron/MeetingPersistence.ts');
  const database = read('electron/db/DatabaseManager.ts');
  const meetingSummary = llm.slice(
    llm.indexOf('public async generateMeetingSummary'),
    llm.indexOf('public async switchToOllama'),
  );
  assert.match(
    meetingSummary,
    /useHintilyManaged[\s\S]*activeSessionId[\s\S]*managed_session_required_for_summary[\s\S]*generateWithHintilyManaged/,
  );
  assert.match(
    persistence,
    /recoverUnprocessedMeetings[\s\S]*managedSession\.activeSurface !== 'meeting'[\s\S]*armManagedRecovery\(managedSession\)/,
  );
  assert.match(
    persistence,
    /armManagedRecovery[\s\S]*managedSession\.once\('activated'[\s\S]*recoverUnprocessedMeetings\(\)/,
  );
  assert.match(persistence, /managedRecoveryArmed[\s\S]*this\.managedRecoveryArmed = false/);
  assert.match(persistence, /getUnprocessedMeetings\(managedOwnerAccountId\)/);
  assert.match(database, /owner_account_id/);
  assert.match(database, /WHERE is_processed = 0 AND owner_account_id = \?/);
  assert.match(
    persistence,
    /processAndSaveMeeting\(snapshot, m\.id, null, null, 'live'\)/,
    'crash recovery must consume the currently active managed Meeting session',
  );
  assert.doesNotMatch(
    managed.slice(managed.indexOf('private async authorizeOnce'), managed.indexOf('async connection(')),
    /notifyActivated/,
  );
  assert.match(
    managed,
    /REQUIRED_AUDIO_CHANNELS[\s\S]*if \(this\.serverActive\)[\s\S]*this\.notifyActivated\(target\)/,
  );
});

test('Stop ends Deepgram billing before bounded post-meeting AI starts', () => {
  const main = read('electron/main.ts');
  const llm = read('electron/LLMHelper.ts');
  const ai = read('supabase/functions/hintily-ai/index.ts');
  const migration = read('supabase/migrations/202607280003_hintily_phases_6_to_10.sql');
  const stopBlock = main.slice(
    main.indexOf('Failed to authorize managed post-processing'),
    main.indexOf('// 4. RAG cleanup'),
  );
  assert.ok(
    stopBlock.indexOf('releaseStt()') < stopBlock.indexOf('stopMeeting()'),
    'Deepgram must close before post-meeting generation begins',
  );
  assert.match(llm, /purpose: 'live' \| 'post_meeting'/);
  assert.match(llm, /'post_meeting'/);
  assert.match(ai, /requested_purpose: purpose/);
  assert.match(migration, /hintily_begin_post_processing/);
  assert.match(migration, /post_processing_until = grant_until/);
  assert.match(migration, /post_processing_requests_remaining = 64/);
  assert.match(migration, /requested_purpose = 'post_meeting'/);
  assert.match(migration, /post_processing_requests_remaining - 1/);
  assert.match(migration, /create or replace function public\.hintily_finalize_session/);
  assert.match(
    migration,
    /post_processing_until = null,[\s\S]*post_processing_requests_remaining = 0[\s\S]*hintily_complete_session/,
  );
  assert.match(
    read('supabase/functions/hintily-business/index.ts'),
    /action === 'complete'[\s\S]*hintily_finalize_session/,
    'desktop completion must use the atomic backend finalizer',
  );
  assert.match(
    migration,
    /revoke all on function public\.hintily_complete_session\(uuid, text\)\s+from public, anon, authenticated/,
    'authenticated clients must not bypass atomic finalization through the legacy RPC',
  );
  assert.match(
    read('electron/services/business/HintilyManagedSession.ts'),
    /completeSession\([\s\S]*if \(!completed\.ok\)[\s\S]*throw new Error[\s\S]*this\.sessionId = null/,
    'local retry handles must only be cleared after confirmed finalization',
  );
  assert.match(
    read('electron/services/business/HintilyManagedSession.ts'),
    /preservePostProcessing[\s\S]*if \(target && !preservePostProcessing\)[\s\S]*completeSession/,
    'exact exhaustion must not finalize an authorized post-meeting summary early',
  );
  assert.match(
    read('electron/services/business/HintilyManagedSession.ts'),
    /if \(!target && this\.postProcessingSessionId\) return;[\s\S]*preservePostProcessing/,
    'a duplicate channel exhaustion event must not cancel preserved post-processing',
  );
});

test('partial-refund failures persist separately and remain retryable', () => {
  const webhook = read('supabase/functions/hintily-dodo-webhook/index.ts');
  const migration = read('supabase/migrations/202607280003_hintily_phases_6_to_10.sql');
  assert.match(webhook, /partialError[\s\S]*hintily_record_dodo_webhook_failure/);
  assert.match(migration, /create or replace function public\.hintily_record_dodo_webhook_failure/);
  assert.match(migration, /status = 'failed'[\s\S]*attempts = public\.webhook_events\.attempts \+ 1/);
  assert.match(
    migration,
    /on conflict \(provider, provider_event_id\)[\s\S]*status = 'processing'[\s\S]*where public\.webhook_events\.status = 'failed'/,
  );
  assert.match(
    migration,
    /if cumulative_refunded >= purchase_row\.amount_minor then[\s\S]*status = 'received'[\s\S]*error_code = 'provider_reconciliation_required'[\s\S]*where public\.webhook_events\.status = 'failed'/,
    'a failed partial refund that becomes cumulative-full must be claimable by the terminal handler',
  );
  assert.doesNotMatch(
    migration,
    /exception when others then\s*update public\.webhook_events[\s\S]*raise/,
  );
});
