import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../../../..//${path}`, import.meta.url), 'utf8');

test('launcher setup derives choices from Modes Manager and passes an explicit surface', () => {
  const setup = read('src/components/hintily/HintilyDetailedSessionSetup.tsx');
  assert.match(setup, /modesEnsureLauncherDefaults/);
  assert.match(setup, /modeMatchesSurface/);
  assert.match(setup, /surface,\s*modeId:/);
});

test('resume, JD file, and pasted JD use secured Electron ingestion', () => {
  const setup = read('src/components/hintily/HintilyDetailedSessionSetup.tsx');
  const ipc = read('electron/ipcHandlers.ts');
  assert.match(setup, /profileSelectFile/);
  assert.match(setup, /profileUploadResume/);
  assert.match(setup, /profileUploadJDText/);
  assert.match(ipc, /profile:upload-jd-text/);
  assert.match(ipc, /maxJdTextLength = 100_000/);
  assert.match(ipc, /hasHintilyFeatureAccess/);
});

test('start revalidates auth, access, documents, permissions, and devices', () => {
  const setup = read('src/components/hintily/HintilyDetailedSessionSetup.tsx');
  const accountContext = read('src/lib/hintily/HintilyAccountContext.tsx');
  assert.match(setup, /refreshAccess\(true\)/);
  assert.doesNotMatch(setup, /hintilyAuthRefresh/);
  assert.match(accountContext, /refreshAuth[\s\S]*hintilyAuthRefresh/);
  assert.match(setup, /profileGetStatus/);
  assert.match(setup, /checkPermissions/);
  assert.match(setup, /getInputDevices/);
  assert.match(setup, /startRef\.current/);
});

test('main process validates mode surface and devices before authorization', () => {
  const ipc = read('electron/ipcHandlers.ts');
  assert.match(ipc, /mode_surface_mismatch/);
  assert.match(ipc, /audio_device_disconnected/);
  assert.match(ipc, /setSttProvider\('hintily'\)/);
  assert.match(ipc, /managedSession\.authorize\(surface\)/);
  assert.match(ipc, /appState\.startMeeting\(validatedMetadata\)/);
  assert.match(ipc, /managedSession\.waitUntilActivated\(\)/);
  assert.match(
    ipc,
    /waitUntilActivated\(\)[\s\S]*setWindowMode\('overlay'\)[\s\S]*publishMeetingStarted\(\)/,
  );
});

test('launcher context is volatile and reaches live and summary prompt paths', () => {
  const modes = read('electron/services/ModesManager.ts');
  const ipc = read('electron/ipcHandlers.ts');
  assert.match(modes, /setLauncherSessionContext/);
  assert.match(modes, /getActiveModePinnedInstructions[\s\S]*launcherContext/);
  assert.match(modes, /launcher_session_context/);
  assert.match(ipc, /setLauncherSessionContext\(null\)/);
});
