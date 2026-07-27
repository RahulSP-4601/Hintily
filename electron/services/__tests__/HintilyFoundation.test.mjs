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
