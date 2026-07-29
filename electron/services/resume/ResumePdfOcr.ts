import { createRequire } from 'node:module';
import * as path from 'node:path';

export type ResumePageSource = 'native' | 'ocr' | 'native+ocr';

export interface ResumePageExtraction {
  pageNumber: number;
  text: string;
  source: ResumePageSource;
  qualityScore: number;
  nativeCharacterCount: number;
  ocrConfidence?: number;
  ocrAttempted?: boolean;
  ocrError?: string;
  renderedPageWasBlank?: boolean;
}

interface NativePdfPage {
  pageNumber: number;
  text: string;
}

const requireFromBundle = createRequire(__filename);
const MIN_HEALTHY_CHARACTERS = 120;
const MIN_HEALTHY_WORDS = 20;
const MIN_ACCEPTABLE_OCR_CONFIDENCE = 0.45;
const PDF_RENDER_SCALE = 3;
const OCR_PAGE_TIMEOUT_MS = 45_000;
const OCR_TOTAL_TIMEOUT_MS = 120_000;
const OCR_CLEANUP_TIMEOUT_MS = 5_000;

export const withResumeOcrDeadline = async <T>(
  operation: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> => {
  if (timeoutMs <= 0) throw new Error(`${label} timed out`);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const normalizePageText = (value: unknown): string => String(value || '')
  .replace(/\r\n?/g, '\n')
  .replace(/[\t\f\v]+/g, ' ')
  .replace(/[ \u00a0]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const scoreResumePageText = (value: unknown): number => {
  const text = normalizePageText(value);
  if (!text) return 0;
  const characters = Array.from(text);
  const readable = characters.filter((character) =>
    /[\p{L}\p{N}\p{P}\p{S}\s]/u.test(character)).length;
  const alphaNumeric = characters.filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  const replacementCharacters = characters.filter((character) => character === '\ufffd').length;
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}+.#/@'-]*/gu) || [];

  const characterScore = Math.min(1, alphaNumeric / MIN_HEALTHY_CHARACTERS);
  const wordScore = Math.min(1, words.length / MIN_HEALTHY_WORDS);
  const readableRatio = readable / Math.max(1, characters.length);
  const replacementPenalty = Math.min(0.5, replacementCharacters / Math.max(1, characters.length));
  return Math.max(
    0,
    Math.min(1, (characterScore * 0.4) + (wordScore * 0.35) + (readableRatio * 0.25) - replacementPenalty),
  );
};

export const resumePageNeedsOcr = (value: unknown): boolean => {
  const text = normalizePageText(value);
  const wordCount = text.match(/[\p{L}\p{N}][\p{L}\p{N}+.#/@'-]*/gu)?.length || 0;
  const alphaNumericCount = text.match(/[\p{L}\p{N}]/gu)?.length || 0;
  return (
    alphaNumericCount < MIN_HEALTHY_CHARACTERS
    || wordCount < MIN_HEALTHY_WORDS
    || scoreResumePageText(text) < 0.72
  );
};

const resumeTextLooksCorrupt = (value: unknown): boolean => {
  const text = normalizePageText(value);
  if (!text) return false;

  const characters = Array.from(text);
  const alphaNumericCount = characters.filter((character) => /[\p{L}\p{N}]/u.test(character)).length;
  const replacementCount = characters.filter((character) => character === '\ufffd').length;
  const lexicalDensity = alphaNumericCount / Math.max(1, characters.length);

  return replacementCount > 0 || alphaNumericCount === 0 || lexicalDensity < 0.3;
};

export const resumePageIsUnreadable = (candidate: ResumePageExtraction): boolean => {
  if (!candidate.ocrAttempted || !candidate.ocrError) return false;

  const text = normalizePageText(candidate.text);
  if (!text) {
    // Empty OCR output is safe only when the rendered pixels independently
    // prove the source page is blank. Otherwise an unreadable scanned page
    // would be silently omitted when another page supplies enough document text.
    return candidate.renderedPageWasBlank !== true;
  }
  if (resumeTextLooksCorrupt(text)) return true;

  // Preserve clean sparse native text (for example, a name-only cover page)
  // when OCR fails. Low-confidence OCR cannot replace an empty/corrupt layer.
  return candidate.ocrConfidence != null
    && candidate.ocrConfidence < MIN_ACCEPTABLE_OCR_CONFIDENCE
    && (candidate.nativeCharacterCount === 0 || candidate.source !== 'native');
};

export const markUnreadableResumeOcrOutput = (
  candidate: ResumePageExtraction,
): ResumePageExtraction => {
  if (resumeTextLooksCorrupt(candidate.text)) {
    candidate.ocrError = 'OCR completed, but the page remains below the readable-text threshold';
  } else if (
    candidate.source !== 'native'
    && candidate.ocrConfidence != null
    && candidate.ocrConfidence < MIN_ACCEPTABLE_OCR_CONFIDENCE
  ) {
    candidate.ocrError =
      `OCR confidence remained below the acceptance threshold (${candidate.ocrConfidence.toFixed(2)})`;
  } else {
    candidate.ocrError = undefined;
  }
  return candidate;
};

const mergeComplementaryPageText = (nativeText: string, ocrText: string): string => {
  if (!nativeText) return ocrText;
  if (!ocrText) return nativeText;
  const nativeLines = nativeText.split('\n').map((line) => line.trim()).filter(Boolean);
  const normalizedNative = new Set(nativeLines.map((line) => line.toLowerCase().replace(/\W+/g, ' ').trim()));
  const supplementalOcrLines = ocrText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      const normalized = line.toLowerCase().replace(/\W+/g, ' ').trim();
      if (normalized.length < 3) return false;
      for (const existing of normalizedNative) {
        if (existing.includes(normalized) || normalized.includes(existing)) return false;
      }
      return true;
    });
  return [...nativeLines, ...supplementalOcrLines].join('\n');
};

const renderedCanvasIsBlank = (
  canvas: {
    width: number;
    height: number;
    getContext: (type: '2d') => any;
  },
  createCanvas: (width: number, height: number) => any,
): boolean => {
  const sampleWidth = Math.max(1, Math.min(128, Math.ceil(canvas.width)));
  const sampleHeight = Math.max(1, Math.min(128, Math.ceil(canvas.height)));
  const sample = createCanvas(sampleWidth, sampleHeight);
  const context = sample.getContext('2d');
  context.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
  const pixels = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
  let visiblePixels = 0;
  let inkPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3];
    if (alpha <= 8) continue;
    visiblePixels += 1;
    const luminance =
      (pixels[offset] * 0.2126)
      + (pixels[offset + 1] * 0.7152)
      + (pixels[offset + 2] * 0.0722);
    if (luminance < 245) inkPixels += 1;
  }
  const sampledPixels = sampleWidth * sampleHeight;
  const inkThreshold = Math.max(2, Math.floor(sampledPixels * 0.0005));
  return visiblePixels === 0 || inkPixels <= inkThreshold;
};

/**
 * OCR is deliberately isolated from electron/services/screen/OcrProvider.ts.
 * Screen OCR remains runtime-disabled and unchanged; this worker is created
 * only when a resume PDF page has an unusable native text layer.
 */
export const extractResumePdfPagesWithSelectiveOcr = async (
  binary: Buffer,
  nativePages: NativePdfPage[],
): Promise<ResumePageExtraction[]> => {
  const startedAt = Date.now();
  const remainingTotalMs = (): number => OCR_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
  const pageDeadlineMs = (): number => Math.min(OCR_PAGE_TIMEOUT_MS, remainingTotalMs());
  const pages: ResumePageExtraction[] = nativePages.map((page) => ({
    pageNumber: page.pageNumber,
    text: normalizePageText(page.text),
    source: 'native' as const,
    qualityScore: scoreResumePageText(page.text),
    nativeCharacterCount: normalizePageText(page.text).length,
  }));
  const pagesNeedingOcr = pages.filter((page) => resumePageNeedsOcr(page.text));
  if (!pagesNeedingOcr.length) return pages;

  try {
    const [{ createCanvas }, pdfjsLib, Tesseract, languageData] = await Promise.all([
      import('@napi-rs/canvas'),
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('tesseract.js'),
      import('@tesseract.js-data/eng'),
    ]);
    const workerPath = requireFromBundle.resolve('tesseract.js/src/worker-script/node/index.js');
    const corePath = path.dirname(requireFromBundle.resolve('tesseract.js-core'));
    const loadingTask = pdfjsLib.getDocument({
      data: Uint8Array.from(binary),
      isEvalSupported: false,
      useSystemFonts: true,
    });
    const document = await withResumeOcrDeadline(
      loadingTask.promise,
      'resume PDF OCR document load',
      remainingTotalMs(),
    );
    let worker: Awaited<ReturnType<typeof Tesseract.createWorker>> | undefined;
    try {
      const workerStartup = Tesseract.createWorker(
        'eng',
        Tesseract.OEM.LSTM_ONLY,
        {
          workerPath,
          corePath,
          langPath: languageData.default?.langPath || languageData.langPath,
          gzip: languageData.default?.gzip ?? languageData.gzip ?? true,
          cacheMethod: 'none',
        },
      );
      try {
        worker = await withResumeOcrDeadline(
          workerStartup,
          'resume OCR worker startup',
          remainingTotalMs(),
        );
      } catch (error) {
        // Promise.race cannot cancel createWorker(). If it completes after our
        // deadline, terminate that late worker instead of leaking its thread.
        void workerStartup
          .then((lateWorker) => lateWorker.terminate())
          .catch((): undefined => undefined);
        throw error;
      }
      await withResumeOcrDeadline(
        worker.setParameters({
          tessedit_pageseg_mode: Tesseract.PSM.AUTO,
          preserve_interword_spaces: '1',
        }),
        'resume OCR worker configuration',
        remainingTotalMs(),
      );

      for (const candidate of pagesNeedingOcr) {
        candidate.ocrAttempted = true;
        try {
          const pdfPage = await withResumeOcrDeadline(
            document.getPage(candidate.pageNumber),
            `resume OCR page ${candidate.pageNumber} load`,
            pageDeadlineMs(),
          );
          const viewport = pdfPage.getViewport({ scale: PDF_RENDER_SCALE });
          const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          const context = canvas.getContext('2d');
          await withResumeOcrDeadline(
            pdfPage.render({
              canvas,
              canvasContext: context,
              viewport,
            } as any).promise,
            `resume OCR page ${candidate.pageNumber} render`,
            pageDeadlineMs(),
          );
          candidate.renderedPageWasBlank = renderedCanvasIsBlank(canvas, createCanvas);
          const result = await withResumeOcrDeadline(
            worker.recognize(canvas.toBuffer('image/png')),
            `resume OCR page ${candidate.pageNumber} recognition`,
            pageDeadlineMs(),
          );
          const ocrText = normalizePageText(result.data.text);
          const ocrQuality = scoreResumePageText(ocrText);
          const confidence = Math.max(0, Math.min(1, Number(result.data.confidence || 0) / 100));

          if (!ocrText) {
            candidate.ocrError = 'OCR returned no readable text';
            continue;
          }
          candidate.ocrConfidence = confidence;
          if (confidence < MIN_ACCEPTABLE_OCR_CONFIDENCE) {
            candidate.ocrError =
              `OCR confidence remained below the acceptance threshold (${confidence.toFixed(2)})`;
            continue;
          }
          if (!candidate.text || ocrQuality >= candidate.qualityScore + 0.08) {
            candidate.text = ocrText;
            candidate.source = 'ocr';
            candidate.qualityScore = ocrQuality;
          } else {
            const merged = mergeComplementaryPageText(candidate.text, ocrText);
            const mergedQuality = scoreResumePageText(merged);
            if (merged.length > candidate.text.length && mergedQuality >= candidate.qualityScore) {
              candidate.text = merged;
              candidate.source = 'native+ocr';
              candidate.qualityScore = mergedQuality;
            }
          }
          markUnreadableResumeOcrOutput(candidate);
        } catch (error) {
          // Retain the native text, but expose the failure so the resume
          // boundary can reject a partially unreadable document rather than
          // silently indexing only the pages that happened to succeed.
          candidate.ocrError = error instanceof Error ? error.message : String(error);
        }
      }
    } finally {
      const cleanup: Promise<unknown>[] = [
        withResumeOcrDeadline(
          Promise.resolve(document.destroy()),
          'resume OCR PDF cleanup',
          OCR_CLEANUP_TIMEOUT_MS,
        ),
      ];
      if (worker) {
        cleanup.push(withResumeOcrDeadline(
          worker.terminate(),
          'resume OCR worker cleanup',
          OCR_CLEANUP_TIMEOUT_MS,
        ));
      }
      await Promise.allSettled(cleanup);
    }
  } catch (error) {
    // Preserve native text for diagnostics, but mark every page that needed
    // OCR. The caller decides whether incomplete extraction is acceptable.
    const message = error instanceof Error ? error.message : String(error);
    for (const candidate of pagesNeedingOcr) {
      candidate.ocrAttempted = true;
      candidate.ocrError ||= message;
    }
  }
  return pages;
};
