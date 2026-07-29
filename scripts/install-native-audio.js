const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const sourceArgument = process.argv[2];
if (!sourceArgument) {
  throw new Error(
    'Pass the downloaded native-audio artifact directory or .node file. Example: ' +
    '`npm run install:native-audio -- ~/Downloads/hintily-native-audio-macos`.',
  );
}

const binaryNames = {
  arm64: 'index.darwin-arm64.node',
  x64: 'index.darwin-x64.node',
};
const binaryName = binaryNames[process.arch];

if (process.platform !== 'darwin' || !binaryName) {
  throw new Error(`The downloadable macOS native-audio artifact does not support ${process.platform}/${process.arch}.`);
}

const projectRoot = path.join(__dirname, '..');
const resolvedSource = path.resolve(sourceArgument);
const source = fs.statSync(resolvedSource).isDirectory()
  ? path.join(resolvedSource, binaryName)
  : resolvedSource;

if (path.basename(source) !== binaryName) {
  throw new Error(`Expected ${binaryName}, received ${path.basename(source)}.`);
}
if (!fs.existsSync(source)) {
  throw new Error(`Native-audio binary not found: ${source}`);
}

const fileDescription = execFileSync('file', ['-b', source], { encoding: 'utf8' });
const expectedArchitecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
if (!fileDescription.includes('Mach-O') || !fileDescription.includes(expectedArchitecture)) {
  throw new Error(
    `Refusing to install an incompatible native binary. Expected Mach-O ${expectedArchitecture}; ` +
    `file reported: ${fileDescription.trim()}`,
  );
}

const destination = path.join(projectRoot, 'native-module', binaryName);
const temporary = `${destination}.installing-${process.pid}`;

try {
  fs.copyFileSync(source, temporary);
  fs.chmodSync(temporary, 0o755);
  fs.renameSync(temporary, destination);
} finally {
  fs.rmSync(temporary, { force: true });
}

console.log(`[install-native-audio] Installed native-module/${binaryName}`);
