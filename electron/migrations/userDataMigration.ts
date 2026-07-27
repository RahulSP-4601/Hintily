import fs from 'node:fs';
import path from 'node:path';

const MARKER_NAME = '.hintily-user-data-migration-v1.json';

export interface UserDataMigrationResult {
  status: 'migrated' | 'already_migrated' | 'no_legacy_data' | 'same_directory';
  source?: string;
  copiedEntries?: number;
}

function copyMissing(source: string, destination: string): number {
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink()) return 0;

  if (sourceStat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    let copied = 0;
    for (const entry of fs.readdirSync(source)) {
      copied += copyMissing(path.join(source, entry), path.join(destination, entry));
    }
    return copied;
  }

  if (!sourceStat.isFile() || fs.existsSync(destination)) return 0;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  try {
    fs.chmodSync(destination, sourceStat.mode);
  } catch {
    // Permission preservation is best-effort; copied content remains usable.
  }
  return 1;
}

export function migrateLegacyUserData(
  appDataPath: string,
  userDataPath: string,
  legacyDirectoryNames = ['Natively', 'natively'],
): UserDataMigrationResult {
  const markerPath = path.join(userDataPath, MARKER_NAME);
  if (fs.existsSync(markerPath)) return { status: 'already_migrated' };

  const normalizedDestination = path.resolve(userDataPath);
  const source = legacyDirectoryNames
    .map((name) => path.join(appDataPath, name))
    .find((candidate) => fs.existsSync(candidate) && fs.lstatSync(candidate).isDirectory());

  if (!source) {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ status: 'no_legacy_data', at: new Date().toISOString() }));
    return { status: 'no_legacy_data' };
  }
  if (path.resolve(source) === normalizedDestination) {
    return { status: 'same_directory', source };
  }

  const copiedEntries = copyMissing(source, userDataPath);
  fs.writeFileSync(
    markerPath,
    JSON.stringify({
      status: 'migrated',
      source,
      copiedEntries,
      at: new Date().toISOString(),
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  return { status: 'migrated', source, copiedEntries };
}
