#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const lock = require(path.join(root, 'package-lock.json'));
const canvasVersion = lock.packages?.['node_modules/@napi-rs/canvas']?.version;

if (!canvasVersion) {
  throw new Error('Could not determine @napi-rs/canvas version from package-lock.json');
}

const requiredPackages = [
  { name: '@napi-rs/canvas-darwin-arm64', binary: 'skia.darwin-arm64.node' },
  { name: '@napi-rs/canvas-darwin-x64', binary: 'skia.darwin-x64.node' },
];
const hasUsableBinary = ({ name, binary }) => {
  const binaryPath = path.join(root, 'node_modules', ...name.split('/'), binary);
  try {
    const stats = fs.statSync(binaryPath);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
};
const missingPackages = requiredPackages.filter((requiredPackage) => !hasUsableBinary(requiredPackage));

if (missingPackages.length === 0) {
  console.log('[ensure-canvas-mac-deps] Both macOS canvas binaries are installed');
  process.exit(0);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-darwin-dep-'));

try {
  for (const { name: packageName } of missingPackages) {
    console.log(`[ensure-canvas-mac-deps] Installing ${packageName}@${canvasVersion}`);
    const packOutput = execFileSync(
      'npm',
      ['pack', `${packageName}@${canvasVersion}`, '--silent'],
      { cwd: tempDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    ).trim();
    const tarballName = packOutput.split(/\r?\n/).filter(Boolean).at(-1);
    if (!tarballName) {
      throw new Error(`npm pack did not return a tarball for ${packageName}`);
    }

    const destination = path.join(root, 'node_modules', ...packageName.split('/'));
    fs.mkdirSync(destination, { recursive: true });
    execFileSync(
      'tar',
      [
        '-xzf',
        path.join(tempDir, tarballName),
        '--strip-components=1',
        '-C',
        destination,
      ],
      { stdio: 'inherit' },
    );
  }
  const stillMissing = requiredPackages.filter((requiredPackage) => !hasUsableBinary(requiredPackage));
  if (stillMissing.length > 0) {
    throw new Error(
      `Canvas package extraction did not produce: ${stillMissing.map(({ binary }) => binary).join(', ')}`,
    );
  }
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('[ensure-canvas-mac-deps] macOS canvas binaries are ready');
