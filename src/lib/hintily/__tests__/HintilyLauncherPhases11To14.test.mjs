import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

test('active session monitoring is server-anchored and exposes provider readiness', () => {
  const panel = read('src/components/hintily/HintilyActiveSessionPanel.tsx');
  const managed = read('electron/services/business/HintilyManagedSession.ts');
  assert.match(panel, /maximumSeconds - active\.consumed_seconds/);
  assert.match(panel, /performance\.now\(\)/);
  assert.match(panel, /refreshAccess\(false\)/);
  assert.match(panel, /hintilySessionGetRuntimeStatus/);
  assert.match(panel, /onSttStatusChanged/);
  assert.match(managed, /\[600, 300, 60\]/);
});

test('recovery reuses the authorized surface and exposes an explicit end action', () => {
  const setup = read('src/components/hintily/HintilyDetailedSessionSetup.tsx');
  const managed = read('electron/services/business/HintilyManagedSession.ts');
  const ipc = read('electron/ipcHandlers.ts');
  assert.match(setup, /resumableSession/);
  assert.match(setup, /'Resume'/);
  assert.match(managed, /existingSession\?\.client_session_id \?\? randomUUID\(\)/);
  assert.match(managed, /this\.surface !== surface/);
  assert.match(ipc, /hintily-session:end-active/);
});

test('history persists explicit Hintily metadata and keeps legacy records honest', () => {
  const persistence = read('electron/MeetingPersistence.ts');
  const launcher = read('src/components/Launcher.tsx');
  assert.match(persistence, /buildHintilySessionMetadata\(metadataSnapshot, modeSnapshot\)/);
  assert.match(persistence, /hintilySession: hintilySessionMetadata/);
  assert.match(launcher, /Legacy session/);
  assert.match(launcher, /status unavailable/);
});

test('exhaustion and authentication changes stop live providers and persist termination state', () => {
  const ipc = read('electron/ipcHandlers.ts');
  const managed = read('electron/services/business/HintilyManagedSession.ts');
  assert.match(ipc, /on\('exhausted'/);
  assert.match(ipc, /beginHintilyMeetingCleanup\('exhausted'\)/);
  assert.match(ipc, /beginHintilyMeetingCleanup\('interrupted'\)/);
  assert.match(managed, /this\.cancelAiRequests\(\)/);
  assert.match(managed, /this\.emit\('exhausted'\)/);
});
