// electron/services/SafeDocumentTextExtractor.ts
//
// Shared safety checks and text extraction for trusted, user-selected documents.
// Callers own authorization and persistence. This module enforces file
// safety (extension, size, BOM, symlink) and uses the same parser path
// for every trusted filesystem ingress so the Modes Manager upload and the
// Profile Intelligence upload cannot drift.
//
// Extracted from electron/services/ModeReferenceFileIngestion.ts so a single
// file owns the parser + safety contract.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
  extractResumePdfPagesWithSelectiveOcr,
  resumePageIsUnreadable,
  scoreResumePageText,
  type ResumePageExtraction,
} from './resume/ResumePdfOcr';

/** The complete shared document-format contract for Modes + Profile uploads. */
export const SAFE_DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.csv', '.tsv',
  '.xml', '.html', '.htm', '.log', '.pdf', '.docx',
]);

/** 50 MB hard cap — should be enforced by the upload UI's progress bar first. */
export const SAFE_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 30_000;

let pdfjsWorkerSrcPinned = false;

const withTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${PARSE_TIMEOUT_MS}ms`)),
          PARSE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    ),
  );
  return results;
};

/**
 * Pinned once per process. pdf-parse@2.x wraps pdfjs-dist@5.4.296 (legacy
 * build) whose `new URL("./pdf.worker.mjs", import.meta.url)` default
 * resolves to a missing dist-electron/electron/pdf.worker.mjs under
 * esbuild's bundle. Pin to the real path on first call.
 */
const pinPdfjsWorkerSrcOnce = async (): Promise<void> => {
  if (pdfjsWorkerSrcPinned) return;
  const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const current = pdfjsLib?.GlobalWorkerOptions?.workerSrc;
  let currentIsBroken = !current || current === './pdf.worker.mjs';
  if (current && !currentIsBroken) {
    try {
      const candidatePath = current.startsWith('file://') ? fileURLToPath(current) : current;
      currentIsBroken = !fs.existsSync(candidatePath);
    } catch {
      currentIsBroken = true;
    }
  }
  if (currentIsBroken) {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
  }
  pdfjsWorkerSrcPinned = true;
};

/**
 * Decode a plain-text extension's bytes to a Unicode string. BOM is
 * stripped. UTF-16 BE is detected and byte-swapped; UTF-16 LE is detected
 * via BOM; UTF-8 with BOM is stripped; everything else is decoded as
 * UTF-8. A run of NUL bytes in the first 2 KiB throws — the file is
 * almost certainly binary and was mislabeled.
 */
const parseTextFile = (buffer: Buffer, fileName: string, ext: string): string => {
  if (buffer.length === 0) throw new Error(`${fileName} is empty`);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return swapped.toString('utf16le');
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8');
  }
  if (buffer.subarray(0, Math.min(2048, buffer.length)).includes(0)) {
    throw new Error(`${fileName} looks binary despite ${ext}`);
  }
  return buffer.toString('utf8');
};

export interface SafeDocumentTextExtractResult {
  filePath: string;
  fileName: string;
  extension: string;
  content: string;
  binarySha256: string;
  pageCount?: number;
  extractedPageCount?: number;
  hyperlinks?: string[];
  hyperlinkEvidence?: Array<{
    target: string;
    label: string;
    pageNumber: number;
    isHeaderContactCandidate: boolean;
  }>;
  pages?: ResumePageExtraction[];
  ocrPageCount?: number;
  unreadablePageNumbers?: number[];
}

export interface SafeResumeExtractResult extends SafeDocumentTextExtractResult {
  normalizedContent: string;
  preview: string;
}

export const SAFE_RESUME_EXTENSIONS = new Set(['.pdf', '.docx', '.txt']);
export const SAFE_RESUME_MAX_BYTES = 10 * 1024 * 1024;

export const isResumeContactHost = (target: string, expectedHost: string): boolean => {
  try {
    const hostname = new URL(target).hostname.toLowerCase().replace(/^www\./, '');
    return hostname === expectedHost || hostname.endsWith(`.${expectedHost}`);
  } catch {
    return false;
  }
};

export const selectResumeWebsiteContact = (
  evidence: NonNullable<SafeDocumentTextExtractResult['hyperlinkEvidence']>,
  linkedin?: string,
  github?: string,
): string | undefined => evidence.find((item) =>
  item.isHeaderContactCandidate
  && /\b(?:portfolio|website|personal site)\b/i.test(item.label)
  && item.target !== linkedin
  && item.target !== github)?.target;

export const selectResumeSocialContact = (
  evidence: NonNullable<SafeDocumentTextExtractResult['hyperlinkEvidence']>,
  expectedHost: 'linkedin.com' | 'github.com',
): string | undefined => evidence.find((item) =>
  item.isHeaderContactCandidate
  && isResumeContactHost(item.target, expectedHost))?.target;

const normalizeResumeText = (input: string): string => input
  .replace(/\r\n?/g, '\n')
  .replace(/[\t\f\v]+/g, ' ')
  .replace(/[ \u00a0]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const extractSafeResumeDocument = async (
  inputFilePath: string,
): Promise<SafeResumeExtractResult> => {
  const resolved = path.resolve(inputFilePath);
  const extension = path.extname(resolved).toLowerCase();
  if (!SAFE_RESUME_EXTENSIONS.has(extension)) throw new Error('resume format must be PDF, DOCX, or TXT');
  const stats = await fs.promises.lstat(resolved);
  if (!stats.isFile()) throw new Error('selected path is not a regular file');
  if (stats.size === 0) throw new Error('resume is empty');
  if (stats.size > SAFE_RESUME_MAX_BYTES) throw new Error('resume exceeds 10 MB limit');
  const header = Buffer.alloc(Math.min(8, stats.size));
  const handle = await fs.promises.open(resolved, 'r');
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  if (extension === '.pdf' && header.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('file signature does not match PDF');
  }
  if (extension === '.docx' && !(header[0] === 0x50 && header[1] === 0x4b)) {
    throw new Error('file signature does not match DOCX');
  }
  let extracted: SafeDocumentTextExtractResult;
  try {
    extracted = await extractSafeDocumentText(resolved, { resumeOcrFallback: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (extension === '.pdf' && /password|encrypted/i.test(message)) {
      throw new Error('password-protected PDFs are not supported');
    }
    throw error;
  }
  const hyperlinkTargets = extracted.hyperlinks || [];
  const hyperlinkEvidence = extracted.hyperlinkEvidence || [];
  const contactHyperlinks: string[] = [];
  const linkedin = selectResumeSocialContact(hyperlinkEvidence, 'linkedin.com');
  const github = selectResumeSocialContact(hyperlinkEvidence, 'github.com');
  if (linkedin) contactHyperlinks.push(`LinkedIn: ${linkedin}`);
  if (github) contactHyperlinks.push(`GitHub: ${github}`);

  // PDF annotations retain their visible labels, so a "Portfolio" contact can
  // be distinguished from employer, publication, and project links. Do not
  // guess when a PDF supplies only an unlabeled generic annotation.
  const labeledWebsite = selectResumeWebsiteContact(hyperlinkEvidence, linkedin, github);
  const visibleHeader = extracted.content.split(/\r?\n/).slice(0, 16).join(' ');
  const visibleWebsiteTarget = hyperlinkTargets.find((target) => {
    if (target === linkedin || target === github) return false;
    try {
      const hostname = new URL(target).hostname.replace(/^www\./i, '');
      return hostname.length > 0 && visibleHeader.toLowerCase().includes(hostname.toLowerCase());
    } catch {
      return false;
    }
  });
  const website = labeledWebsite || visibleWebsiteTarget;
  if (website) {
    contactHyperlinks.push(`Website: ${website}`);
  }

  const linkEvidence = contactHyperlinks.length
    ? `\n\n[Document contact hyperlinks]\n${contactHyperlinks.join('\n')}`
    : '';
  const normalizedContent = normalizeResumeText(`${extracted.content}${linkEvidence}`);
  const unreadablePageNumbers = extracted.unreadablePageNumbers || [];
  if (extension === '.pdf' && unreadablePageNumbers.length > 0) {
    throw new Error(
      `resume OCR could not read page${unreadablePageNumbers.length === 1 ? '' : 's'} `
      + `${unreadablePageNumbers.join(', ')}; export a searchable PDF or upload a clearer scan`,
    );
  }
  const meaningful = normalizedContent.replace(/\[Page \d+\]/g, '').match(/[\p{L}\p{N}]/gu)?.length || 0;
  if (meaningful < 20 || normalizedContent.split(/\s+/).length < 3) {
    if (extension === '.pdf' && extracted.pageCount &&
        (!extracted.extractedPageCount || extracted.extractedPageCount === 0)) {
      throw new Error('scanned PDF could not be read by the resume OCR fallback');
    }
    throw new Error('resume extraction produced too little readable text');
  }
  return {
    ...extracted,
    normalizedContent,
    preview: normalizedContent.slice(0, 2_000),
  };
};

/**
 * Extract text from a user-selected regular file. Callers MUST authorize the
 * path (and the file's provenance as a "user selected it" event) before
 * calling this function. This module enforces file safety only — extension,
 * size, BOM, binary-mislabel, symlink. PDF/DOCX/text parsing goes through
 * the same code path the Modes upload already trusted (extracted from
 * ModeReferenceFileIngestion).
 */
export const extractSafeDocumentText = async (
  inputFilePath: string,
  options: { resumeOcrFallback?: boolean } = {},
): Promise<SafeDocumentTextExtractResult> => {
  const filePath = path.resolve(inputFilePath);
  const fileName = path.basename(filePath);
  const extension = path.extname(fileName).toLowerCase();
  if (!SAFE_DOCUMENT_EXTENSIONS.has(extension)) {
    throw new Error(`unsupported file type ${extension || 'none'}`);
  }

  const stats = await fs.promises.lstat(filePath);
  if (!stats.isFile()) throw new Error('selected path is not a regular file');
  if (stats.size > SAFE_DOCUMENT_MAX_BYTES) throw new Error('file exceeds 50 MB limit');

  const binary = await fs.promises.readFile(filePath);
  const binarySha256 = crypto.createHash('sha256').update(binary).digest('hex');
  let content = '';
  let pageCount: number | undefined;
  let extractedPageCount: number | undefined;
  let hyperlinks: string[] | undefined;
  let hyperlinkEvidence: SafeDocumentTextExtractResult['hyperlinkEvidence'];
  let pages: ResumePageExtraction[] | undefined;
  let ocrPageCount: number | undefined;
  let unreadablePageNumbers: number[] | undefined;

  if (extension === '.pdf') {
    await pinPdfjsWorkerSrcOnce();
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: binary });
    let data: any;
    try {
      data = await withTimeout<any>(parser.getText(), 'PDF parse');
    } finally {
      try {
        await parser.destroy();
      } catch {
        // Cleanup is best-effort. Teardown must not replace a successful
        // extraction result or conceal the original parse failure.
      }
    }
    pageCount =
      typeof data?.total === 'number' && data.total > 0
        ? data.total
        : Array.isArray(data?.pages)
          ? data.pages.length
          : undefined;
    if (Array.isArray(data?.pages) && data.pages.length > 0) {
      extractedPageCount = data.pages.filter(
        (page: any) => typeof page?.text === 'string' && page.text.trim(),
      ).length;
      const nativePages = data.pages.map((page: any, index: number) => ({
        pageNumber: Number(page?.num) || index + 1,
        text: typeof page?.text === 'string' ? page.text : '',
      }));
      pages = options.resumeOcrFallback
        ? await extractResumePdfPagesWithSelectiveOcr(binary, nativePages)
        : nativePages.map((page: { pageNumber: number; text: string }) => ({
            ...page,
            source: 'native' as const,
            qualityScore: scoreResumePageText(page.text),
            nativeCharacterCount: page.text.trim().length,
          }));
      extractedPageCount = pages.filter((page) => page.text.trim()).length;
      ocrPageCount = pages.filter((page) => page.source !== 'native').length;
      unreadablePageNumbers = pages
        .filter(resumePageIsUnreadable)
        .map((page) => page.pageNumber);
      content = pages
        .map((page) => `[Page ${page.pageNumber}]\n${page.text}`)
        .join('\n\n');
    } else {
      const nativeText = String(data?.text || '');
      const nativePages = [{
        pageNumber: 1,
        text: nativeText,
      }];
      pages = options.resumeOcrFallback
        ? await extractResumePdfPagesWithSelectiveOcr(binary, nativePages)
        : [{
            ...nativePages[0],
            source: 'native',
            qualityScore: scoreResumePageText(nativeText),
            nativeCharacterCount: nativeText.trim().length,
          }];
      extractedPageCount = pages.filter((page) => page.text.trim()).length;
      ocrPageCount = pages.filter((page) => page.source !== 'native').length;
      unreadablePageNumbers = pages
        .filter(resumePageIsUnreadable)
        .map((page) => page.pageNumber);
      content = pages.map((page) => `[Page ${page.pageNumber}]\n${page.text}`).join('\n\n');
    }

    if (options.resumeOcrFallback) {
      // Text extraction does not include PDF annotation targets. Résumés often
      // render only "LinkedIn" or "Portfolio" while the actual URL lives in an
      // annotation, so retain those targets as source evidence. Ordinary PDF
      // imports skip this second parse, and résumé pages use bounded concurrency
      // to avoid loading an entire large document into memory at once.
      let pdfDocument: any = null;
      try {
        const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const loadingTask = pdfjsLib.getDocument({
          data: Uint8Array.from(binary),
          isEvalSupported: false,
        });
        pdfDocument = await withTimeout<any>(loadingTask.promise, 'PDF link parse');
        const pageNumbers = Array.from(
          { length: pdfDocument.numPages },
          (_, index) => index + 1,
        );
        const pageEvidence = await mapWithConcurrency(
          pageNumbers,
          4,
          async (pageNumber) => {
            try {
              const page = await withTimeout<any>(pdfDocument.getPage(pageNumber), 'PDF page link parse');
              const viewport = page.getViewport({ scale: 1 });
              const [annotations, textContent] = await Promise.all([
                withTimeout<any[]>(page.getAnnotations(), 'PDF annotation parse'),
                withTimeout<any>(page.getTextContent(), 'PDF link-label text parse'),
              ]);
              return annotations.flatMap((annotation) => {
                const target = String(annotation?.url || annotation?.unsafeUrl || '').trim();
                if (!/^https?:\/\/\S+$/i.test(target)) return [];
                const rect = Array.isArray(annotation?.rect) ? annotation.rect.map(Number) : [];
                const viewportRect = rect.length === 4
                  ? viewport.convertToViewportRectangle(rect)
                  : [];
                const annotationTop = viewportRect.length === 4
                  ? Math.min(Number(viewportRect[1]), Number(viewportRect[3]))
                  : Number.POSITIVE_INFINITY;
                const isHeaderContactCandidate = pageNumber === 1
                  && annotationTop <= Number(viewport.height) * 0.35;
                const label = rect.length === 4
                  ? (textContent?.items || [])
                    .filter((item: any) => {
                      const transform = Array.isArray(item?.transform) ? item.transform : [];
                      if (transform.length < 6) return false;
                      const x = Number(transform[4]);
                      const y = Number(transform[5]);
                      const width = Math.max(Number(item?.width) || 0, 1);
                      const height = Math.max(Number(item?.height) || Math.abs(Number(transform[3])) || 0, 1);
                      const tolerance = 3;
                      return x + width >= Math.min(rect[0], rect[2]) - tolerance
                        && x <= Math.max(rect[0], rect[2]) + tolerance
                        && y + height >= Math.min(rect[1], rect[3]) - tolerance
                        && y - height <= Math.max(rect[1], rect[3]) + tolerance;
                    })
                    .map((item: any) => String(item?.str || '').trim())
                    .filter(Boolean)
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                  : '';
                return [{ target, label, pageNumber, isHeaderContactCandidate }];
              });
            } catch {
              // Link annotations are optional enrichment. Preserve evidence from
              // healthy pages when one malformed page cannot be inspected.
              return [];
            }
          },
        );
        const uniqueEvidence = new Map<string, {
          target: string;
          label: string;
          pageNumber: number;
          isHeaderContactCandidate: boolean;
        }>();
        for (const evidence of pageEvidence.flat()) {
          const key = `${evidence.pageNumber}\0${evidence.target}\0${evidence.label}`;
          uniqueEvidence.set(key, evidence);
        }
        hyperlinkEvidence = [...uniqueEvidence.values()];
        hyperlinks = [...new Set(hyperlinkEvidence.map((evidence) => evidence.target))];
      } catch {
        // Annotation extraction is enrichment. A malformed link must never
        // discard otherwise valid PDF text.
      } finally {
        if (pdfDocument) {
          try {
            await pdfDocument.destroy();
          } catch {
            // Cleanup is best-effort. A destroy failure must not replace a
            // successful text extraction with an unrelated cleanup error.
          }
        }
      }
    }
  } else if (extension === '.docx') {
    const mammoth = require('mammoth');
    const data: any = await withTimeout<any>(mammoth.extractRawText({ path: filePath }), 'DOCX parse');
    content = String(data?.value || '');
  } else {
    content = parseTextFile(binary, fileName, extension);
  }

  if (!content.trim()) throw new Error('file parsed to empty text');

  return {
    filePath,
    fileName,
    extension,
    content,
    binarySha256,
    pageCount,
    extractedPageCount,
    hyperlinks,
    hyperlinkEvidence,
    pages,
    ocrPageCount,
    unreadablePageNumbers,
  };
};
