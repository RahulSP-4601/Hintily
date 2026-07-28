import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('packaged customer UI hides Natively commerce and BYOK provider configuration', () => {
  const brand = read('src/config/brand.ts');
  const settings = read('src/components/SettingsOverlay.tsx');
  const processing = read('electron/ProcessingHelper.ts');
  const credentials = read('electron/services/CredentialsManager.ts');
  const ipc = read('electron/ipcHandlers.ts');

  assert.match(brand, /LEGACY_NATIVELY_COMMERCE_ENABLED = false/);
  assert.match(brand, /import\.meta\.env\.DEV[\s\S]*VITE_HINTILY_ENABLE_LEGACY_BYOK_DEV/);
  assert.match(settings, /LEGACY_PROVIDER_CONFIGURATION_ENABLED && \(\s*<button[\s\S]*AI Providers/);
  assert.match(processing, /!app\.isPackaged && process\.env\.HINTILY_ENABLE_LEGACY_BYOK_DEV/);
  assert.match(processing, /legacyProviderConfigurationAllowed \? credManager\.getGeminiApiKey\(\) : undefined/);
  assert.match(processing, /legacyProviderConfigurationAllowed \? credManager\.getDefaultModel\(\) : null/);
  assert.match(credentials, /if \(!legacyProviderConfigurationAllowed\) \{[\s\S]*delete process\.env\[name\]/);
  assert.match(credentials, /getGeminiApiKey\(\)[\s\S]*legacyProviderConfigurationAllowed/);
  assert.match(credentials, /getSttProvider\(\)[\s\S]*if \(!legacyProviderConfigurationAllowed\) return 'hintily'/);
  assert.doesNotMatch(credentials, /return 'hintily-managed'/);
  assert.match(ipc, /provider_configuration_disabled/);
  assert.match(ipc, /isLegacyBusinessChannel[\s\S]*channel\.startsWith\('license:'\)[\s\S]*channel\.startsWith\('trial:'\)/);
  assert.match(ipc, /!legacyBusinessLogicAllowed\(\) && isLegacyBusinessChannel\(channel\)[\s\S]*legacyBusinessDisabledResult\(channel\)/);
  assert.match(ipc, /license:check-premium[\s\S]*return false/);
  assert.match(ipc, /license:get-details[\s\S]*isPremium: false/);
  assert.match(ipc, /'get-natively-pricing'/);
  assert.match(ipc, /const hasHintilyFeatureAccess = async[\s\S]*hintilyBusiness\.getAccountState\(\)/);
  assert.match(ipc, /state\.data\.unlimited[\s\S]*free_session_available[\s\S]*paid_session_count[\s\S]*active_session/);
  for (const channel of [
    'set-gemini-api-key',
    'set-groq-api-key',
    'set-openai-api-key',
    'set-claude-api-key',
    'set-deepseek-api-key',
    'set-litellm-config',
    'set-natively-api-key',
    'save-custom-provider',
    'save-curl-provider',
    'set-deepgram-api-key',
  ]) {
    const start = ipc.indexOf(`safeHandle('${channel}'`);
    assert.notEqual(start, -1, `${channel} handler must exist for compatibility`);
    assert.match(
      ipc.slice(start, start + 500),
      /legacyProviderConfigurationAllowed\(\)/,
      `${channel} must fail closed outside explicit development mode`,
    );
  }
});

test('Google OAuth and sign-out are the only Hintily account actions', () => {
  const auth = read('electron/services/auth/HintilyAuthService.ts');
  const ipc = read('electron/ipcHandlers.ts');
  const account = read('src/components/settings/HintilyAccountSettings.tsx');

  assert.match(auth, /signInWithOAuth\(\{[\s\S]*provider: 'google'/);
  assert.doesNotMatch(auth, /signInWithPassword|\.auth\.signUp/);
  assert.match(auth, /auth\.signOut\(\{ scope: 'global' \}\)/);
  assert.match(ipc, /stopForAuthChange\('signed_out'\)[\s\S]*hintilyAuth\.signOut\(\)/);
  assert.match(ipc, /cancelAccountScopedWork[\s\S]*accountScopedAbortControllers[\s\S]*accountScopedCancellers/);
  assert.match(ipc, /accountChanged[\s\S]*stopForAuthChange\(reason\)/);
  assert.match(account, /Sign out/);
});

test('single-use allocation migration consumes activated sessions and restores pending startup failures', () => {
  const migration = read('supabase/migrations/202607280001_hintily_single_use_sessions.sql');

  assert.match(migration, /session_type in \('free', 'paid'\)/);
  assert.match(migration, /session_type = 'free' and maximum_seconds = 1200/);
  assert.match(migration, /session_type = 'paid' and maximum_seconds = 3600/);
  assert.match(migration, /was_activated := target\.status in \('active', 'paused'\)/);
  assert.match(migration, /if was_activated then[\s\S]*status = 'consumed'/);
  assert.match(migration, /forfeited_seconds = greatest\(maximum_seconds - consumed_seconds, 0\)/);
  assert.match(migration, /else[\s\S]*status = 'available'/);
  assert.match(migration, /where user_id = caller and \(kind = 'trial' or session_type = 'free'\)/);
});

test('provider readiness precedes allocation activation', () => {
  const managed = read('electron/services/business/HintilyManagedSession.ts');
  const deepgram = read('electron/audio/DeepgramStreamingSTT.ts');
  const authorizeBody = managed.slice(
    managed.indexOf('private async authorizeOnce'),
    managed.indexOf('async connection('),
  );
  assert.doesNotMatch(authorizeBody, /activateSession/);
  assert.match(authorizeBody, /checkManagedAiReady\(authorized\.data\.session_id\)/);
  assert.match(authorizeBody, /'ai_startup_failed'/);
  assert.match(managed, /channelConnected\(channel: ManagedAudioChannel\): void \{[\s\S]*this\.maybeActivate\(\)/);
  assert.match(managed, /if \(!this\.activated[\s\S]*this\.aiProviderReady[\s\S]*REQUIRED_AUDIO_CHANNELS[\s\S]*activateAfterProviderReady/);
  const managedAi = read('supabase/functions/hintily-ai/index.ts');
  assert.match(managedAi, /session\.status !== 'pending' && session\.status !== 'active'/);
  assert.match(managedAi, /session\.status !== 'active'/);
  assert.match(managedAi, /HINTLY_MANAGED_OPENAI_API_KEY/);
  assert.match(managedAi, /action === 'ready'[\s\S]*readinessRequest\(provider\)/);
  assert.match(managedAi, /api\.openai\.com\/v1\/chat\/completions/);
  assert.match(managedAi, /readinessRequest[\s\S]*'Reply OK'/);
  assert.match(managedAi, /READINESS_TIMEOUT_MS = 8_000/);
  assert.match(managedAi, /max_completion_tokens: 2/);
  assert.match(managedAi, /maxOutputTokens: 2/);
  assert.match(managedAi, /'x-goog-api-key': apiKey/);
  assert.doesNotMatch(managedAi, /\?key=/);
  assert.match(managedAi, /hintily_ai_claim_readiness/);
  assert.match(managedAi, /claim\.state === 'cached'/);
  assert.match(managedAi, /requested_claim_id: claimId/);
  assert.match(managedAi, /hintily_ai_finish_readiness/);
  assert.match(managedAi, /hintily_ai_begin_request/);
  assert.match(managedAi, /hintily_ai_end_request/);
  const aiEnforcement = read('supabase/migrations/202607280002_hintily_ai_enforcement.sql');
  assert.match(aiEnforcement, /from public\.deepgram_stream_leases[\s\S]*started_at is not null[\s\S]*expires_at > now\(\)/);
  assert.match(aiEnforcement, /active_requests >= 3/);
  assert.match(aiEnforcement, /rate\.request_count >= 30/);
  assert.match(aiEnforcement, /ai_ready_at is not null[\s\S]*'cached'/);
  assert.match(aiEnforcement, /ai_readiness_claimed_at > now\(\) - interval '30 seconds'/);
  assert.match(aiEnforcement, /ai_readiness_claim_id = requested_claim_id/);
  assert.match(aiEnforcement, /to service_role/);
  assert.doesNotMatch(aiEnforcement, /to authenticated/);
  const llmHelper = read('electron/LLMHelper.ts');
  assert.match(llmHelper, /maxImageDataChars = 4_000_000/);
  assert.match(llmHelper, /imageDataChars \+ data\.length > maxImageDataChars/);
  assert.match(llmHelper, /useHintilyManaged[\s\S]*return this\.generateWithHintilyManaged/);
  assert.match(llmHelper, /waitUntilActivated\(\)/);
  assert.match(llmHelper, /registerAiRequest\(requestController\)/);
  assert.match(llmHelper, /AbortSignal\.any\(signals\)/);
  assert.match(managed, /get activeSessionId\(\): string \| null \{\s*return this\.activated \? this\.sessionId : null/);
  assert.match(managed, /channelStartupFailed[\s\S]*this\.serverActive[\s\S]*this\.stop\('stt_connection_failed'\)/);
  assert.match(managed, /private cancelAiRequests\(\): void/);
  assert.match(managed, /channelStartupFailed[\s\S]*'stt_startup_failed'/);
  assert.match(deepgram, /stopConnection\(true, 'retry_exhausted'\)/);
  assert.match(deepgram, /stopConnection\(true, 'requested'\)/);
  const deepgramProxy = read('supabase/functions/hintily-deepgram-stream/index.ts');
  assert.match(deepgramProxy, /HINTILY_MANAGED_DEEPGRAM_API_KEY/);
  assert.match(deepgramProxy, /HINTLY_MANAGED_DEEPGRAM_API_KEY/);
  const main = read('electron/main.ts');
  assert.match(main, /reason === 'retry_exhausted'[\s\S]*channelStartupFailed\(speaker\)/);
  assert.match(managed, /activateAfterProviderReady[\s\S]*activateSession\(target\)/);
  assert.match(deepgram, /Max reconnect attempts reached[\s\S]*stopConnection\(true, 'retry_exhausted'\)/);
  assert.match(managed, /completeSession\(\s*target,\s*failureCode,\s*cleanupToken \|\| undefined/);
});

test('Dodo products use exact INR prices and support saved Hintily environment aliases', () => {
  const dodo = read('supabase/functions/_shared/dodo.ts');
  const webhook = read('supabase/functions/hintily-dodo-webhook/index.ts');
  const checkout = read('supabase/functions/hintily-checkout/index.ts');

  for (const amount of ['49_900', '109_900', '189_900', '279_900', '339_900', '749_700', '2_518_800', '3_500_000']) {
    assert.match(dodo, new RegExp(amount));
  }
  assert.match(dodo, /HINTLY_DODO_PRODUCTS_JSON/);
  assert.match(dodo, /HINTLY_\$\{prefix\}_DODO_PRODUCT_ID/);
  assert.match(dodo, /HINTLY_\$\{prefix\}_CHECKOUT_URL/);
  assert.match(webhook, /payment_amount_mismatch/);
  assert.match(webhook, /receivedCurrency !== 'INR'/);
  assert.match(webhook, /subscriptionLifecycle[\s\S]*recurring_pre_tax_amount/);
  assert.match(checkout, /DODO_API_KEY/);
  assert.match(checkout, /DODO_API_BASE_URL/);
  assert.match(checkout, /metadata: \{ hintily_user_id: auth\.user\.id, hintily_product_code: code \}/);
  assert.doesNotMatch(checkout, /return response\(200, \{ checkout_url: product\.checkoutUrl/);
});

test('account UI presents exact prices and no-carry-forward rule', () => {
  const account = read('src/components/settings/HintilyAccountSettings.tsx');
  for (const price of ['₹499', '₹1,099', '₹1,899', '₹2,799', '₹3,399', '₹7,497', '₹25,188', '₹35,000']) {
    assert.match(account, new RegExp(price));
  }
  assert.match(account, /Ending early consumes that session/);
  assert.match(account, /unused time does not carry forward/);
  assert.match(account, /single-use 20-minute free session/);
});
