import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('launcher account state is shared by launcher and account settings', () => {
  const app = read('src/App.tsx');
  const launcher = read('src/components/Launcher.tsx');
  const accountSettings = read('src/components/settings/HintilyAccountSettings.tsx');

  assert.match(app, /<HintilyAccountProvider>[\s\S]*<Launcher[\s\S]*<SettingsOverlay/);
  assert.match(launcher, /useHintilyAccount\(\)/);
  assert.match(accountSettings, /useHintilyAccount\(\)/);
  assert.doesNotMatch(accountSettings, /hintilyBusinessEnsureTrial\(\)/);
});

test('Google authentication gates setup and server bootstraps the free allocation', () => {
  const context = read('src/lib/hintily/HintilyAccountContext.tsx');
  const setup = read('src/components/hintily/LauncherSessionSetup.tsx');
  const migration = read('supabase/migrations/202607280001_hintily_single_use_sessions.sql');

  assert.match(context, /hintilyBusinessEnsureTrial\(\)/);
  assert.match(setup, /if \(!signedIn\)[\s\S]*Continue with Google/);
  assert.match(setup, /signInWithGoogle/);
  assert.match(migration, /is_google_identity/);
  assert.match(migration, /where not exists \([\s\S]*kind = 'trial' or session_type = 'free'/);
  assert.match(migration, /'available', 1200, 1200, 0/);
});

test('checkout verification is account-bound and revision-bound', () => {
  const context = read('src/lib/hintily/HintilyAccountContext.tsx');

  assert.match(context, /interface CheckoutBaseline \{[\s\S]*userId: string;[\s\S]*revision: string \| null;/);
  assert.match(context, /baseline\.userId !== userId/);
  assert.match(context, /result\.data\.access_revision !== baselineRevision/);
  assert.match(context, /hintilyBusinessCreateCheckout\(productCode\)/);
  assert.doesNotMatch(context, /outcome === 'success'[\s\S]{0,500}hasAccess\s*=\s*true/);
});

test('launcher passes an explicit selected business surface to session startup', () => {
  const launcher = read('src/components/Launcher.tsx');
  const app = read('src/App.tsx');
  const ipc = read('electron/ipcHandlers.ts');

  assert.match(launcher, /type HintilyLauncherSurface/);
  assert.match(launcher, /onStart=\{onStartMeeting\}/);
  assert.match(app, /request: HintilyLauncherStartRequest/);
  assert.match(app, /startMeeting\(\{[\s\S]*\.\.\.metadata/);
  assert.match(ipc, /requestedSurface === 'interview_helper' \|\| requestedSurface === 'meeting'/);
});

test('launcher blocks starting without authenticated authoritative access', () => {
  const launcher = read('src/components/Launcher.tsx');

  assert.match(
    launcher,
    /canStartHintilySession = signedInToHintily[\s\S]*!hintilyAccountLoading[\s\S]*hasHintilyAccess/,
  );
  assert.match(launcher, /if \(!canStartHintilySession\) \{[\s\S]*focusSessionSetup\(\);[\s\S]*return;/);
});

test('public plan catalogue stays aligned with the server grant catalogue', () => {
  const renderer = read('src/config/hintilyProducts.ts');
  const server = read('supabase/functions/_shared/dodo.ts');
  const codes = [
    'session_1',
    'session_3',
    'session_7',
    'session_12',
    'unlimited_monthly',
    'unlimited_quarterly',
    'unlimited_yearly',
    'unlimited_lifetime',
  ];

  for (const code of codes) {
    assert.match(renderer, new RegExp(`code: '${code}'`));
    assert.match(server, new RegExp(`${code}:`));
  }
});
