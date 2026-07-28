import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (relativePath) =>
  readFileSync(new URL(`../../../${relativePath}`, import.meta.url), 'utf8');

test('Hintily authentication keeps credentials out of the renderer', () => {
  const preload = read('electron/preload.ts');
  const authService = read('electron/services/auth/HintilyAuthService.ts');

  assert.match(authService, /flowType:\s*'pkce'/);
  assert.match(authService, /autoRefreshToken:\s*true/);
  assert.match(authService, /event === 'TOKEN_REFRESHED'/);
  assert.match(authService, /void this\.acceptSession\(session\)/);
  assert.match(authService, /keytar\.setPassword/);
  assert.match(authService, /persistSession:\s*false/);
  assert.doesNotMatch(preload, /access_token|refresh_token|SERVICE_ROLE/i);
  assert.doesNotMatch(authService, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(authService, /signOut\(\{ scope: 'global' \}\)/);
  assert.match(authService, /isTerminalRefreshError/);
  assert.match(authService, /await this\.clearLocalSession\(\)/);
});

test('account deletion verifies the user and performs a hard delete server-side', () => {
  const accountFunction = read('supabase/functions/hintily-account/index.ts');

  assert.match(accountFunction, /userClient\.auth\.getUser\(\)/);
  assert.match(accountFunction, /admin\.auth\.admin\.deleteUser\(data\.user\.id,\s*false\)/);
  assert.match(accountFunction, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('foundation schema enables RLS and denies client-side financial mutations', () => {
  const migration = read('supabase/migrations/202607270001_hintily_foundation.sql');
  const protectedTables = [
    'entitlements',
    'purchases',
    'session_allocations',
    'business_sessions',
    'usage_sessions',
    'webhook_events',
  ];

  for (const table of protectedTables) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(
    migration,
    /revoke insert, update, delete on public\.entitlements, public\.purchases, public\.session_allocations, public\.business_sessions, public\.usage_sessions from anon, authenticated/,
  );
  assert.match(migration, /unique \(provider, provider_payment_id\)/);
  assert.match(migration, /unique \(provider, provider_event_id\)/);
  assert.match(migration, /con\.conkey = array\[/);
  assert.match(migration, /insert into public\.user_profiles\(user_id, display_name, avatar_url\)/);
  assert.match(migration, /from auth\.users as users/);
  assert.match(migration, /on conflict \(user_id\) do nothing/);
});

test('existing Supabase compatibility migration is replayable and non-destructive', () => {
  const migration = read(
    'supabase/migrations/202607270002_hintily_existing_project_compat.sql',
  );
  const tables = [
    'user_profiles',
    'entitlements',
    'purchases',
    'session_allocations',
    'business_sessions',
    'usage_sessions',
    'webhook_events',
    'review_prompt_state',
    'reviews',
  ];

  for (const table of tables) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table if exists public\\.${table}`));
  }
  assert.match(migration, /add column if not exists allocated_seconds integer/);
  assert.match(migration, /add column if not exists provider_payment_id text/);
  assert.match(migration, /on delete set null/);
  assert.match(migration, /where columns\.column_name is null/);
  assert.doesNotMatch(migration, /\bdrop table\b|\btruncate\b|\bdelete from\b/i);
});

test('phases 5–9 keep grants and metered usage behind server-side functions', () => {
  const sessions = read('supabase/migrations/202607270003_hintily_business_sessions.sql');
  const payments = read('supabase/migrations/202607270004_hintily_dodo_processing.sql');
  const webhook = read('supabase/functions/hintily-dodo-webhook/index.ts');
  const token = read('supabase/functions/hintily-deepgram-token/index.ts');
  const business = read('electron/services/business/HintilyBusinessService.ts');
  const managed = read('electron/services/business/HintilyManagedSession.ts');
  const ipcHandlers = read('electron/ipcHandlers.ts');
  const businessFunction = read('supabase/functions/hintily-business/index.ts');

  assert.match(sessions, /'free_trial'.*'20 Minute Free Trial'/s);
  assert.match(sessions, /'trial', 'available', 1200, 0/);
  assert.match(sessions, /for update skip locked limit 1/);
  assert.match(sessions, /on conflict \(business_session_id, sequence_no\) do nothing/);
  assert.match(sessions, /least\(requested_active_seconds/);
  assert.match(sessions, /'access_revision'/);
  assert.match(sessions, /'next_sequence_no'.*max\(u\.sequence_no\) \+ 1/s);
  assert.match(
    sessions,
    /if target\.allocation_id is not null then[\s\S]*if not found then raise exception 'session_not_activatable'[\s\S]*if not unlimited_access then raise exception 'session_not_activatable'/,
  );
  assert.match(
    businessFunction,
    /session_not_active\|session_not_activatable/,
  );
  assert.match(payments, /'paid', 'available', 3600, 0/);
  assert.match(payments, /grants_access boolean/);
  assert.match(payments, /consumed_seconds < (?:a\.)?allocated_seconds/);
  assert.match(payments, /on conflict \(provider, provider_event_id\)\s+where provider_event_id is not null/);
  assert.match(payments, /on conflict \(provider, provider_payment_id\)\s+where provider_payment_id is not null/);
  assert.match(payments, /failure_code = 'payment_access_revoked'/);
  assert.match(payments, /status in \('available', 'reserved', 'active'\)/);
  assert.match(payments, /'refund\.succeeded'/);
  assert.doesNotMatch(payments, /'refund\.success'/);
  assert.match(webhook, /verifyDodoSignature\(raw/);
  assert.match(webhook, /event_occurred_at: eventTimestamp/);
  assert.match(webhook, /invalid_event_timestamp/);
  assert.match(webhook, /refund\\\.succeeded/);
  assert.match(webhook, /hintily_apply_dodo_event/);
  assert.match(token, /direct_provider_tokens_disabled/);
  assert.doesNotMatch(token, /DEEPGRAM_API_KEY|auth\/grant/);
  assert.match(business, /Authorization: `Bearer \$\{token\}`/);
  assert.match(business, /options\?\.retry === false \? \[0\] : RETRY_DELAYS/);
  assert.match(business, /\{ retry: false \}/);
  assert.match(business, /captureAccessToken/);
  assert.match(managed, /existingSession\?\.client_session_id \?\? randomUUID\(\)/);
  assert.match(
    managed,
    /if \(this\.authorizing\) \{[\s\S]*this\.authorizingSurface !== surface[\s\S]*return this\.authorizing/,
  );
  assert.match(
    managed,
    /if \(this\.authorizing === attempt\) \{[\s\S]*this\.authorizing = null[\s\S]*this\.authorizingSurface = null/,
  );
  assert.match(managed, /generation !== this\.lifecycleGeneration/);
  assert.match(
    managed,
    /authorization_cancelled'[\s\S]*cleanupToken \|\| undefined/,
  );
  assert.match(
    managed,
    /stt_startup_failed'[\s\S]*cleanupToken \|\| undefined/,
  );
  assert.match(managed, /stopForAuthChange/);
  assert.match(managed, /AUTH_CHANGE_CLEANUP_TIMEOUT_MS = 2_000/);
  assert.match(managed, /Promise\.race\(\[\s*cleanup\.catch/);
  assert.match(managed, /getDeepgramConnection/);
  assert.match(payments, /restores_access boolean := event_type in \('dispute\.won', 'dispute\.cancelled'\)/);
  assert.match(payments, /set status = 'available'[\s\S]*status = 'revoked'/);
  assert.match(payments, /add column if not exists provider_event_at timestamptz/);
  assert.match(payments, /provider_event_at > event_occurred_at/);
  assert.match(payments, /error_code = 'stale_provider_event'/);
  assert.match(payments, /if not terminal and not restores_access and not grants_access then/);
  assert.match(payments, /drop function if exists public\.hintily_apply_dodo_event/);
  assert.match(payments, /create table if not exists public\.provider_event_cutovers/);
  assert.match(payments, /event_occurred_at < ordering_cutover/);
  assert.match(payments, /error_code = 'provider_reconciliation_required'/);
  assert.match(
    payments,
    /do update[\s\S]*status = 'processing'[\s\S]*status = 'received'[\s\S]*error_code = 'provider_reconciliation_required'/,
  );
  assert.match(
    payments,
    /set status = 'received', processed_at = null,[\s\S]*error_code = 'provider_reconciliation_required'/,
  );
  assert.match(ipcHandlers, /fs\.constants\.O_NOFOLLOW[\s\S]*fs\.promises\.open\(/);
  assert.match(ipcHandlers, /extractSafeResumeDocument\(immutableResumePath\)/);
  assert.match(ipcHandlers, /ingestDocument\(immutableResumePath, DocType\.RESUME\)/);
  assert.match(
    ipcHandlers,
    /fs\.promises\.rm\(resumeTempDir, \{ recursive: true, force: true \}\)[\s\S]*\.catch\(/,
  );
  assert.match(
    ipcHandlers,
    /setSttProvider\(previousProvider\)[\s\S]*provider_reconfigure_failed[\s\S]*reconfigureSttProvider\(\)\.catch/,
  );
  assert.doesNotMatch(
    payments,
    /set provider_event_at = coalesce\(provider_event_at, updated_at, created_at\)/,
  );
});

test('managed STT reconnects preserve enforcement and checkout returns survive cold starts', () => {
  const main = read('electron/main.ts');
  const preload = read('electron/preload.ts');
  const deepgram = read('electron/audio/DeepgramStreamingSTT.ts');
  const relay = read('supabase/functions/hintily-deepgram-stream/index.ts');
  const leases = read('supabase/migrations/202607270005_hintily_stream_leases.sql');
  const payments = read('supabase/migrations/202607270004_hintily_dodo_processing.sql');
  const accountSettings = read('src/components/settings/HintilyAccountSettings.tsx');
  const ipcHandlers = read('electron/ipcHandlers.ts');
  const managed = read('electron/services/business/HintilyManagedSession.ts');

  assert.match(deepgram, /this\.emit\('stopped', \{ permanent, reason \}\)/);
  assert.match(deepgram, /connectionGeneration/);
  assert.match(deepgram, /generation !== this\.connectionGeneration/);
  assert.match(main, /dg\.on\('disconnected', disconnectManagedChannel\)/);
  assert.match(main, /dg\.on\('stopped'.*reason === 'retry_exhausted'/s);
  assert.match(main, /managed\.on\('terminate', stopForAuthChange\)/);
  assert.match(main, /process\.argv\.forEach\(handleHintilyDeepLink\)/);
  assert.match(main, /did-finish-load', flushPendingHintilyCheckoutOutcome/);
  assert.match(preload, /pendingHintilyCheckoutReturn/);
  assert.match(preload, /hintilyCheckoutReturnSubscribers/);
  assert.match(relay, /hintily_proxy_heartbeat/);
  assert.match(relay, /new WebSocket\(deepgramUrl, \['token', deepgramKey\]\)/);
  assert.match(relay, /STARTUP_BUFFER_LIMIT_BYTES/);
  assert.match(relay, /startupBuffer\.push\(event\.data\)/);
  assert.match(relay, /hintily_acquire_stream_lease/);
  assert.match(relay, /hintily_renew_stream_lease/);
  assert.match(relay, /hintily_mark_stream_ready/);
  assert.match(relay, /hintily_release_stream_lease/);
  assert.match(relay, /const LEASE_GUARD_MS = 10_000/);
  assert.match(relay, /finishAndClose\(1011, 'provider_closed', true\)/);
  assert.match(relay, /FINAL_METER_TIMEOUT_MS = 2_000/);
  assert.match(relay, /Promise\.race\(\[\s*meter\(true\)/);
  assert.match(relay, /finally \{\s*closeBothNow\(code, reason\)/);
  assert.match(relay, /MAX_TRANSIENT_LEASE_FAILURES = 3/);
  assert.match(relay, /confirmedLeaseLoss/);
  assert.match(relay, /transientLeaseFailures >= MAX_TRANSIENT_LEASE_FAILURES/);
  assert.match(relay, /closed \|\| closing \|\| leaseGuardInFlight/);
  assert.match(relay, /finally \{\s*leaseGuardInFlight = false;/);
  assert.match(relay, /streamReady = true;[\s\S]*for \(const frame of startupBuffer\)/);
  assert.match(relay, /if \(streamReady && upstream\?\.readyState === WebSocket\.OPEN\)/);
  assert.doesNotMatch(relay, /for \(const \[key, value\] of requestUrl\.searchParams\)/);
  assert.match(relay, /deepgramUrl\.searchParams\.set\('model', 'nova-3'\)/);
  assert.match(deepgram, /readonly leaseOwnerId = randomUUID\(\)/);
  assert.match(deepgram, /hintily_lease_owner_id: managed\.leaseOwnerId/);
  assert.match(leases, /primary key \(business_session_id, channel\)/);
  assert.match(leases, /channel in \('interviewer', 'user'\)/);
  assert.match(leases, /expires_at <= now\(\)/);
  assert.match(leases, /lease_id = requested_lease_id/);
  assert.match(leases, /lease_owner_id = excluded\.lease_owner_id/);
  assert.match(leases, /last_heartbeat_at = now\(\)/);
  assert.match(leases, /started_at is not null/);
  assert.match(leases, /interval '25 seconds'/);
  assert.match(leases, /interval '30 seconds'/);
  assert.match(leases, /failure_code = 'payment_access_revoked'/);
  assert.match(leases, /if remaining = 0 then[\s\S]*status = 'completed'/);
  assert.match(leases, /if remaining = 0 then[\s\S]*delete from public\.deepgram_stream_leases/);
  assert.match(payments, /s\.allocation_id is null[\s\S]*not exists \([\s\S]*e\.unlimited/);
  assert.match(accountSettings, /CHECKOUT_BASELINE_KEY/);
  assert.match(accountSettings, /storeCheckoutBaseline\(baseline\)/);
  assert.match(accountSettings, /readCheckoutBaseline\(\)/);
  assert.match(
    accountSettings,
    /hintilyAuthRefresh\(\)[\s\S]*hintilyBusinessGetState\(\)/,
  );
  assert.match(accountSettings, /checkoutBaselineRevision\.current = baseline/);
  assert.match(accountSettings, /disabled=\{busy !== null \|\| checkoutBusy\}/);
  assert.match(
    ipcHandlers,
    /provider === 'hintily'[\s\S]*!managedSession\.authorizedSessionId[\s\S]*managedSession\.authorize\(activeHintilySurface \?\? resolveHintilySurface\(\)\)/,
  );
  assert.match(
    managed,
    /if \(payload\.exhausted\) \{[\s\S]*'time_exhausted'[\s\S]*this\.sessionId = null;[\s\S]*this\.connectedChannels = 0;/,
  );
});

test('legacy environment aliases are isolated to the central config module', () => {
  const config = read('electron/config/hintily.ts');

  assert.match(config, /HINTILY_SUPABASE_URL/);
  assert.match(config, /HINTLY_SUPABASE_URL/);
  assert.match(config, /HINTILY_SUPABASE_ANON_KEY/);
  assert.match(config, /HINTLY_SUPABASE_ANON_KEY/);
  assert.match(config, /environment === 'development' \|\| environment === 'test'/);
  assert.match(config, /loopbackHosts/);
  assert.match(config, /must include a valid explicit port/);
});

test('legacy Natively commerce is disabled without wedging onboarding', () => {
  const brand = read('src/config/brand.ts');
  const app = read('src/App.tsx');
  const toasterHost = read('src/components/onboarding/OrchestratedToasterHost.tsx');

  assert.match(brand, /LEGACY_NATIVELY_COMMERCE_ENABLED = false/);
  assert.match(app, /LEGACY_NATIVELY_COMMERCE_ENABLED && !isolateGlobalSurfaces/);
  assert.match(toasterHost, /orch\.markSkipped\('trial_promo'\)/);
});

test('legacy Natively providers cannot enter runtime routing', () => {
  const credentials = read('electron/services/CredentialsManager.ts');
  const modelSelector = read('src/components/ui/ModelSelector.tsx');
  const modelSelectorWindow = read('src/components/ModelSelectorWindow.tsx');

  assert.match(credentials, /public getNativelyApiKey\(\): string \| undefined \{[\s\S]*?return undefined;/);
  assert.match(credentials, /if \(provider === 'natively'\)[\s\S]*?return 'none';/);
  assert.match(modelSelector, /LEGACY_NATIVELY_COMMERCE_ENABLED && creds\?\.hasNativelyKey/);
  assert.match(modelSelectorWindow, /LEGACY_NATIVELY_COMMERCE_ENABLED && creds\?\.hasNativelyKey/);
});

test('OAuth waits for callback readiness and handles early bind failures', () => {
  const authService = read('electron/services/auth/HintilyAuthService.ts');

  assert.match(authService, /const callbackOutcome:[\s\S]*?callback\.session\.then/);
  assert.match(authService, /await callback\.ready;/);
  assert.match(authService, /once\('listening'/);
  assert.match(authService, /rejectReady\(error\)/);
});

test('account IPC actions wait for keychain session restoration', () => {
  const ipcHandlers = read('electron/ipcHandlers.ts');

  assert.match(ipcHandlers, /const hintilyAuthReady = hintilyAuth\.initialize\(\)/);
  assert.match(ipcHandlers, /await hintilyAuthReady/);
  for (const channel of [
    'hintily-auth:get-status',
    'hintily-auth:sign-in-google',
    'hintily-auth:refresh',
    'hintily-auth:sign-out',
    'hintily-auth:delete-account',
  ]) {
    assert.match(
      ipcHandlers,
      new RegExp(`safeHandle\\('${channel.replaceAll('-', '\\-')}'[\\s\\S]*?afterHintilyAuthReady`),
    );
  }
  assert.match(
    ipcHandlers,
    /hintily-auth:sign-out'[\s\S]*stopForAuthChange\('signed_out'\)[\s\S]*hintilyAuth\.signOut\(\)/,
  );
  assert.match(
    ipcHandlers,
    /hintily-auth:delete-account'[\s\S]*stopForAuthChange\('account_deleted'\)[\s\S]*hintilyAuth\.deleteAccount\(\)/,
  );
});

test('packaged startup performs a non-destructive legacy user-data migration', () => {
  const main = read('electron/main.ts');
  const migration = read('electron/migrations/userDataMigration.ts');

  assert.match(main, /migrateLegacyUserData\(app\.getPath\('appData'\), app\.getPath\('userData'\)\)/);
  assert.match(migration, /COPYFILE_EXCL/);
  assert.doesNotMatch(migration, /renameSync|rmSync|unlinkSync/);
});

test('secret scanning includes tests and fixtures with value-level canaries only', () => {
  const scanner = read('scripts/scan-secrets.mjs');
  const ignoredPartsMatch = scanner.match(/const ignoredParts = new Set\(\[([\s\S]*?)\]\);/);

  assert.ok(ignoredPartsMatch);
  assert.doesNotMatch(ignoredPartsMatch[1], /'tests'|'__tests__'|'fixtures'/);
  assert.match(scanner, /allowedTestCanaries/);
  assert.match(scanner, /'ls-files', '--cached', '--others', '--exclude-standard', '-z'/);
  assert.doesNotMatch(scanner, /allowedTestFiles|ignoredTestFiles/);
  assert.doesNotMatch(scanner, /allowedBasenames/);
  assert.match(scanner, /examplePlaceholder/);
  assert.match(scanner, /fs\.lstatSync\(absolute\)/);
  assert.match(scanner, /error\?\.code === 'ENOENT'/);
  assert.match(scanner, /!stat\.isFile\(\)/);
});

test('packaged public links are validated as credential-free HTTPS URLs', () => {
  const configWriter = read('scripts/write-hintily-public-config.mjs');

  assert.match(configWriter, /requireHttpsUrl/);
  assert.match(configWriter, /'HINTILY_WEBSITE_URL'/);
  assert.match(configWriter, /'HINTILY_SUPPORT_URL'/);
  assert.match(configWriter, /parsedUrl\.protocol !== 'https:'/);
  assert.match(configWriter, /parsedUrl\.username/);
  assert.match(configWriter, /parsedUrl\.password/);
});

test('release artifacts and macOS permission prompts use Hintily branding', () => {
  const dmgBuilder = read('scripts/afterAllArtifactBuild.cjs');
  const plistPatcher = read('scripts/patch-electron-plist.js');
  const releaseUploader = read('scripts/upload-release.mjs');

  assert.match(dmgBuilder, /packageJson\.build\?\.productName \|\| 'Hintily'/);
  assert.match(dmgBuilder, /\{ archDir: 'mac-arm64', suffix: '-arm64' \}/);
  assert.match(dmgBuilder, /\{ archDir: 'mac', suffix: '-x64' \}/);
  assert.match(plistPatcher, /Hintily needs Screen Recording permission/);
  assert.match(plistPatcher, /Hintily needs system audio access/);
  assert.match(plistPatcher, /Hintily needs microphone access/);
  assert.match(plistPatcher, /legacyPermissionDescriptions/);
  assert.match(releaseUploader, /pkg\.build\?\.productName/);
  assert.match(releaseUploader, /escapedProductName/);
  assert.match(releaseUploader, /escapedVersion/);
  assert.match(releaseUploader, /-arm64\\\\\.dmg/);
  assert.match(releaseUploader, /-x64\\\\\.dmg/);
  assert.doesNotMatch(releaseUploader, /\^Natively-/);
});

test('macOS release workflow verifies Hintily and publishes tag assets', () => {
  const workflow = read('.github/workflows/release-macos.yml');
  const releaseGate = read('scripts/release-gate.mjs');

  assert.match(workflow, /-name 'Hintily\.app'/);
  assert.doesNotMatch(workflow, /-name 'Natively\.app'/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(workflow, /gh release create "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /gh release upload "\$GITHUB_REF_NAME" "\$\{ASSETS\[@\]\}" --clobber/);
  assert.match(workflow, /release\/\*\.dmg/);
  assert.match(workflow, /release\/\*\.zip/);
  assert.match(workflow, /release\/\*\.yml/);
  assert.match(workflow, /HINTILY_SUPABASE_URL: \$\{\{ vars\.HINTILY_SUPABASE_URL \}\}/);
  assert.match(workflow, /HINTILY_SUPABASE_ANON_KEY: \$\{\{ secrets\.HINTILY_SUPABASE_ANON_KEY \}\}/);
  assert.match(workflow, /npm run prepare:hintily-config/);
  assert.match(releaseGate, /'Hintily\.app'/);
  assert.match(releaseGate, /owner:\\s\*RahulSP-4601/);
  assert.match(releaseGate, /repo:\\s\*Hintily/);
});
