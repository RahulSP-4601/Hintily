declare module '@tesseract.js-data/eng' {
  interface TesseractLanguageData {
    code: string;
    gzip: boolean;
    langPath: string;
  }

  const languageData: TesseractLanguageData;
  export default languageData;
  export const code: string;
  export const gzip: boolean;
  export const langPath: string;
}
