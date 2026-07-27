#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const ignoredParts = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  'release',
  'models',
]);
const jwt = /\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{10,}\b/;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{200,}-----END/;
const literalSecret = /\b(?:SERVICE_ROLE_KEY|DODO_API_KEY|WEBHOOK_SECRET|DEEPGRAM_API_KEY|OPENAI_API_KEY|GOOGLE_CLIENT_SECRET)=([^\s'"$]{20,})/i;
const providerToken = /\b(?:sk-(?:proj-)?|dodo_(?:live|test)_)[a-zA-Z0-9_-]{20,}\b/;
// Example env files are scanned like every other file. Replace only the
// repository's explicit `your_*_here` template syntax so placeholders do not
// look like long literal credentials; a real value beside them is still caught.
const examplePlaceholder = /\byour_[a-z0-9_]+_here\b/gi;
// Exact canaries used to verify log redaction and credential persistence.
// Keeping this allowlist value-level (not directory- or file-level) ensures a
// different token accidentally added beside a canary is still rejected.
const allowedTestCanaries = new Set([
  'sk-LIVE-LOWERCASE-VARIANT12345',
  'sk-proj-A1B2C3D4E5F6G7H8I9J0_-XYZ',
  'sk-LIVE-ABCDEFG1234567890XYZ',
  'sk-abcdefghijklmnopqrstuvwxyz123456',
  'sk-deepgram-LIVE-abc123',
  'sk-groq-typed-by-user-XYZ',
  'sk-deepgram-LIVE-original',
  'sk-abcdefghijklmnopqrstu',
  'sk-ant-api03-aaaaaaaaaaaaaaaaaaaa',
  'sk-XXXXXXXXXXXXXXXXXXXXX',
  'sk-deepgram-LIVE-SENTINEL-abc123XYZ',
  'sk-groq-STT-LIVE-aaa111',
  'sk-openai-STT-LIVE-bbb222',
  'sk-deepgram-LIVE-ccc333',
  'sk-elevenlabs-LIVE-ddd444',
  'sk-ibmwatson-LIVE-fff666',
  'sk-real-secret-1234567890',
  'sk-real-soniox-LIVE-abc',
  'sk-deepgram-LIVE-9f3c2a1b0e7d4c8a6b5e2f1d0c9b8a7',
]);

// Git is the source of truth for files that can enter a commit. `--cached`
// includes tracked files even when a later .gitignore rule matches them, while
// `--others --exclude-standard` adds commit-eligible untracked files.
const files = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root },
)
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter((file) => !file.split(path.sep).some((part) => ignoredParts.has(part)));

const failures = [];
for (const relative of files) {
  const absolute = path.join(root, relative);
  let stat;
  try {
    // lstat does not follow a tracked symlink out of the repository. Missing
    // paths are expected when a tracked file is staged for deletion.
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch {
    continue;
  }
  text = text.replaceAll(examplePlaceholder, 'placeholder');
  for (const canary of allowedTestCanaries) {
    text = text.replaceAll(canary, '[ALLOWED_TEST_CANARY]');
  }
  if (literalSecret.test(text) || providerToken.test(text) || jwt.test(text) || privateKey.test(text)) {
    failures.push(relative);
  }
}

if (failures.length) {
  console.error(`Potential committed secrets detected:\n${failures.map((f) => ` - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`Secret scan passed (${files.length} files checked).`);
