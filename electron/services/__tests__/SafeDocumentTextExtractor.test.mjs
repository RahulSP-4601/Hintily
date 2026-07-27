// Shared document extraction contract for Modes Manager + Profile Intelligence
// upload paths. Senior-review fix 2026-07-16 (audit ab9dc2f0): this test
// file was lost during the prior broken-commit recovery; restored here to
// pin the safety contract now that ModeReferenceFileIngestion.ts
// (electron/services/) shares this utility.
//
// Run with: npm run build:electron && node --test electron/services/__tests__/SafeDocumentTextExtractor.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(path.resolve(
  __dirname,
  '../../../dist-electron/electron/services/SafeDocumentTextExtractor.js',
)).href;
const {
  extractSafeDocumentText,
  SAFE_DOCUMENT_EXTENSIONS,
  SAFE_DOCUMENT_MAX_BYTES,
  extractSafeResumeDocument,
  SAFE_RESUME_EXTENSIONS,
  SAFE_RESUME_MAX_BYTES,
} = await import(moduleUrl);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'natively-safe-document-'));
const createdPaths = [];

function createFixture(name, content) {
  const filePath = path.join(tempRoot, name);
  fs.writeFileSync(filePath, content);
  createdPaths.push(filePath);
  return filePath;
}

test('declares the complete shared Modes / Profile document format contract', () => {
  assert.deepEqual(
    [...SAFE_DOCUMENT_EXTENSIONS],
    ['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.xml', '.html', '.htm', '.log', '.pdf', '.docx'],
  );
  assert.equal(SAFE_DOCUMENT_MAX_BYTES, 50 * 1024 * 1024);
});

test('resume extraction is restricted to PDF, DOCX, and TXT with a 10 MB cap', () => {
  assert.deepEqual([...SAFE_RESUME_EXTENSIONS], ['.pdf', '.docx', '.txt']);
  assert.equal(SAFE_RESUME_MAX_BYTES, 10 * 1024 * 1024);
});

test('normalizes safe TXT resumes and returns a bounded preview and hash', async () => {
  const resume = createFixture('candidate.txt', 'Sarah Chen\r\n\r\nSenior   Software Engineer\r\nTypeScript');
  const result = await extractSafeResumeDocument(resume);
  assert.equal(result.normalizedContent, 'Sarah Chen\n\nSenior Software Engineer\nTypeScript');
  assert.equal(result.preview, result.normalizedContent);
  assert.match(result.binarySha256, /^[a-f0-9]{64}$/);
});

test('resume extraction rejects misleading signatures and degenerate text', async () => {
  const fakePdf = createFixture('fake.pdf', 'not a pdf despite extension');
  const fakeDocx = createFixture('fake.docx', 'not a zip despite extension');
  const sparse = createFixture('sparse.txt', 'A B');
  await assert.rejects(() => extractSafeResumeDocument(fakePdf), /signature does not match PDF/);
  await assert.rejects(() => extractSafeResumeDocument(fakeDocx), /signature does not match DOCX/);
  await assert.rejects(() => extractSafeResumeDocument(sparse), /too little readable text/);
});

test('extracts every plain-text document format without changing its content', async () => {
  const content = 'Sarah Chen\nsarah@example.com\nSenior Software Engineer\n';
  for (const ext of ['.txt', '.md', '.markdown', '.json', '.csv', '.tsv', '.xml', '.html', '.htm', '.log']) {
    const result = await extractSafeDocumentText(createFixture(`resume${ext}`, content));
    assert.equal(result.extension, ext);
    assert.equal(result.content, content);
    assert.equal(result.binarySha256, crypto.createHash('sha256').update(content).digest('hex'));
  }
});

test('decodes UTF-8 and UTF-16 BOM text safely', async () => {
  const utf8Bom = createFixture('resume.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Sarah Chen')]));
  const utf16Le = createFixture('job-description.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Senior Backend Engineer', 'utf16le')]));
  assert.equal((await extractSafeDocumentText(utf8Bom)).content, 'Sarah Chen');
  assert.equal((await extractSafeDocumentText(utf16Le)).content, 'Senior Backend Engineer');
});

test('rejects unsupported, empty, oversized, and renamed-binary files before they reach extraction', async () => {
  const unsupported = createFixture('resume.rtf', 'Sarah Chen');
  const empty = createFixture('resume.txt', '');
  const oversized = createFixture('resume.log', '');
  const binary = createFixture('resume.json', Buffer.from([0x53, 0x00, 0x01, 0x02]));
  fs.truncateSync(oversized, SAFE_DOCUMENT_MAX_BYTES + 1);

  await assert.rejects(() => extractSafeDocumentText(unsupported), /unsupported file type \.rtf/);
  await assert.rejects(() => extractSafeDocumentText(empty), /empty/);
  await assert.rejects(() => extractSafeDocumentText(oversized), /exceeds 50 MB limit/);
  await assert.rejects(() => extractSafeDocumentText(binary), /looks binary despite \.json/);
});

test('rejects a symlink instead of following it', async (t) => {
  const target = createFixture('real-resume.txt', 'Sarah Chen');
  const link = path.join(tempRoot, 'resume-link.txt');
  try {
    fs.symlinkSync(target, link);
  } catch (error) {
    t.skip(`symlink creation unavailable: ${error.message}`);
    return;
  }
  createdPaths.push(link);
  await assert.rejects(() => extractSafeDocumentText(link), /not a regular file/);
});
