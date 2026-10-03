export type ExtractionInput = {
  fileName: string;
  mimeType: string;
  data: Buffer;
};

/** Turns an uploaded file (PDF, Markdown, plain text) into raw text. */
export interface DocumentTextExtractor {
  /** Throws ValidationError when the file cannot be read. */
  extract(input: ExtractionInput): Promise<string>;
}
