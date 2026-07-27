import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { migrateLegacyUserData } from '../../../dist-electron/electron/migrations/userDataMigration.js';

const temporaryDirectories = [];

const temporaryDirectory = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hintily-migration-test-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('copies missing legacy data without overwriting Hintily data or deleting the source', () => {
  const appData = temporaryDirectory();
  const legacy = path.join(appData, 'Natively');
  const hintily = path.join(appData, 'Hintily');
  fs.mkdirSync(path.join(legacy, 'nested'), { recursive: true });
  fs.mkdirSync(hintily, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings.json'), 'legacy-settings');
  fs.writeFileSync(path.join(legacy, 'nested', 'meetings.db'), 'legacy-db');
  fs.writeFileSync(path.join(hintily, 'settings.json'), 'hintily-settings');

  const result = migrateLegacyUserData(appData, hintily);

  assert.equal(result.status, 'migrated');
  assert.equal(fs.readFileSync(path.join(hintily, 'settings.json'), 'utf8'), 'hintily-settings');
  assert.equal(fs.readFileSync(path.join(hintily, 'nested', 'meetings.db'), 'utf8'), 'legacy-db');
  assert.equal(fs.readFileSync(path.join(legacy, 'nested', 'meetings.db'), 'utf8'), 'legacy-db');
});

test('migration is idempotent after its completion marker is written', () => {
  const appData = temporaryDirectory();
  const legacy = path.join(appData, 'Natively');
  const hintily = path.join(appData, 'Hintily');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'settings.json'), 'first');

  assert.equal(migrateLegacyUserData(appData, hintily).status, 'migrated');
  fs.writeFileSync(path.join(legacy, 'late-file.json'), 'late');
  assert.equal(migrateLegacyUserData(appData, hintily).status, 'already_migrated');
  assert.equal(fs.existsSync(path.join(hintily, 'late-file.json')), false);
});
