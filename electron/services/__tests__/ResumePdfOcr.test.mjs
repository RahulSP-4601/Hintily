import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const {
  extractResumePdfPagesWithSelectiveOcr,
  markUnreadableResumeOcrOutput,
  resumePageIsUnreadable,
  resumePageNeedsOcr,
  scoreResumePageText,
  withResumeOcrDeadline,
} = await import(
  pathToFileURL(path.resolve(
    __dirname,
    '../../../dist-electron/electron/services/resume/ResumePdfOcr.js',
  )).href
);
const {
  isResumeContactHost,
  selectResumeSocialContact,
  selectResumeWebsiteContact,
} = await import(
  pathToFileURL(path.resolve(
    __dirname,
    '../../../dist-electron/electron/services/SafeDocumentTextExtractor.js',
  )).href
);

describe('resume PDF selective OCR quality gate', () => {
  test('sends empty and nearly empty pages to OCR', () => {
    assert.equal(resumePageNeedsOcr(''), true);
    assert.equal(resumePageNeedsOcr('Rahul Panchal'), true);
  });

  test('keeps a healthy native text layer on the fast path', () => {
    const text = `Senior Software Engineer
Built reliable distributed services with TypeScript, Node.js, PostgreSQL, and AWS.
Reduced API latency by 45 percent while supporting more than two million requests daily.
Designed deployment automation and production monitoring for customer-facing applications.`;
    assert.equal(resumePageNeedsOcr(text), false);
    assert.ok(scoreResumePageText(text) >= 0.72);
  });

  test('penalizes corrupt replacement-heavy text', () => {
    const healthy = 'Software engineer building reliable products with TypeScript and PostgreSQL.';
    const corrupt = `${healthy} ${'\ufffd'.repeat(80)}`;
    assert.ok(scoreResumePageText(corrupt) < scoreResumePageText(healthy));
  });

  test('marks non-empty OCR garbage as unreadable instead of accepting it', () => {
    const candidate = {
      pageNumber: 1,
      text: '|||| 1 1 l l ...',
      source: 'ocr',
      qualityScore: 0.1,
      nativeCharacterCount: 0,
      ocrAttempted: true,
    };
    markUnreadableResumeOcrOutput(candidate);
    assert.match(candidate.ocrError, /below the readable-text threshold/i);
    assert.equal(resumePageIsUnreadable(candidate), true);
  });

  test('does not reject legitimate sparse or pixel-verified blank pages after an OCR attempt', () => {
    const sparse = {
      pageNumber: 1,
      text: 'Rahul Panchal',
      source: 'native',
      qualityScore: 0.3,
      nativeCharacterCount: 13,
      ocrAttempted: true,
      ocrError: 'OCR worker unavailable',
    };
    const blank = {
      pageNumber: 2,
      text: '',
      source: 'native',
      qualityScore: 0,
      nativeCharacterCount: 0,
      ocrAttempted: true,
      ocrError: 'OCR returned no readable text',
      renderedPageWasBlank: true,
    };
    assert.equal(resumePageIsUnreadable(sparse), false);
    assert.equal(resumePageIsUnreadable(blank), false);
  });

  test('rejects empty OCR output when rendered pixels did not prove the page was blank', () => {
    const candidate = {
      pageNumber: 2,
      text: '',
      source: 'native',
      qualityScore: 0,
      nativeCharacterCount: 0,
      ocrAttempted: true,
      ocrError: 'OCR returned no readable text',
      renderedPageWasBlank: false,
    };
    assert.equal(resumePageIsUnreadable(candidate), true);
  });

  test('rejects low-confidence OCR when no trustworthy native text exists', () => {
    const candidate = {
      pageNumber: 1,
      text: '',
      source: 'native',
      qualityScore: 0,
      nativeCharacterCount: 0,
      ocrAttempted: true,
      ocrConfidence: 0.18,
      ocrError: 'OCR confidence remained below the acceptance threshold (0.18)',
    };
    assert.equal(resumePageIsUnreadable(candidate), true);
  });

  test('fails a stalled OCR operation within its deadline', async () => {
    await assert.rejects(
      withResumeOcrDeadline(new Promise(() => {}), 'test OCR', 5),
      /test OCR timed out/,
    );
  });

  test('keeps already extracted native text when optional OCR cannot load the PDF', async () => {
    const nativeText = 'Rahul Panchal';
    const pages = await extractResumePdfPagesWithSelectiveOcr(
      Buffer.from('not a valid PDF'),
      [{ pageNumber: 1, text: nativeText }],
    );
    assert.equal(pages.length, 1);
    assert.equal(pages[0].text, nativeText);
    assert.equal(pages[0].source, 'native');
    assert.equal(pages[0].ocrAttempted, true);
    assert.match(pages[0].ocrError, /PDF|document|header|format/i);
  });

  test('recognizes standard and subdomain contact URLs by hostname', () => {
    assert.equal(isResumeContactHost('https://linkedin.com/in/rahul', 'linkedin.com'), true);
    assert.equal(isResumeContactHost('https://www.github.com/rahul', 'github.com'), true);
    assert.equal(isResumeContactHost('https://notgithub.com/rahul', 'github.com'), false);
    assert.equal(isResumeContactHost('not a URL', 'github.com'), false);
  });

  test('only promotes portfolio annotations from the first-page contact header', () => {
    const bodyPortfolio = {
      target: 'https://project.example',
      label: 'Portfolio website',
      pageNumber: 2,
      isHeaderContactCandidate: false,
    };
    assert.equal(selectResumeWebsiteContact([bodyPortfolio]), undefined);
    const headerPortfolio = {
      ...bodyPortfolio,
      target: 'https://candidate.example',
      pageNumber: 1,
      isHeaderContactCandidate: true,
    };
    assert.equal(
      selectResumeWebsiteContact([bodyPortfolio, headerPortfolio]),
      'https://candidate.example',
    );
  });

  test('only promotes social profiles from the first-page contact header', () => {
    const projectRepository = {
      target: 'https://github.com/company/project',
      label: 'Project repository',
      pageNumber: 2,
      isHeaderContactCandidate: false,
    };
    assert.equal(
      selectResumeSocialContact([projectRepository], 'github.com'),
      undefined,
    );
    const candidateProfile = {
      target: 'https://github.com/candidate',
      label: 'GitHub',
      pageNumber: 1,
      isHeaderContactCandidate: true,
    };
    assert.equal(
      selectResumeSocialContact([projectRepository, candidateProfile], 'github.com'),
      'https://github.com/candidate',
    );
  });
});
