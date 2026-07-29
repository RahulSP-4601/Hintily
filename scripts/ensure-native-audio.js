const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const artifacts = {
  darwin: {
    arm64: 'index.darwin-arm64.node',
    x64: 'index.darwin-x64.node',
  },
  linux: {
    arm64: 'index.linux-arm64-gnu.node',
    x64: 'index.linux-x64-gnu.node',
  },
  win32: {
    arm64: 'index.win32-arm64-msvc.node',
    ia32: 'index.win32-ia32-msvc.node',
    x64: 'index.win32-x64-msvc.node',
  },
};

const artifact = artifacts[process.platform]?.[process.arch];
if (!artifact) {
  throw new Error(`Unsupported native-audio platform: ${process.platform}/${process.arch}`);
}

const projectRoot = path.join(__dirname, '..');
const artifactPath = path.join(projectRoot, 'native-module', artifact);

if (fs.existsSync(artifactPath)) {
  console.log(`[ensure-native-audio] Ready: native-module/${artifact}`);
  process.exit(0);
}

if (process.platform === 'darwin') {
  try {
    const developerDirectory = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
    if (!developerDirectory.includes('/Xcode.app/')) {
      throw new Error(`active developer directory is ${developerDirectory}`);
    }
    execFileSync('xcodebuild', ['-version'], { stdio: 'ignore' });
  } catch {
    throw new Error(
      'The Hintily native-audio binary is missing and full Xcode is not available locally. ' +
      'Run the "Build macOS native audio" GitHub Action, download its ' +
      '`hintily-native-audio-macos` artifact, then install it with ' +
      '`npm run install:native-audio -- /path/to/hintily-native-audio-macos`.',
    );
  }
}

console.log(`[ensure-native-audio] Missing native-module/${artifact}; building native audio…`);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execFileSync(npmCommand, ['run', 'build:native'], {
  cwd: projectRoot,
  stdio: 'inherit',
});

if (!fs.existsSync(artifactPath)) {
  throw new Error(`Native audio build completed without producing native-module/${artifact}`);
}

console.log(`[ensure-native-audio] Built: native-module/${artifact}`);
