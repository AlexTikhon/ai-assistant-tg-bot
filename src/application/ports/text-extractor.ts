import type { ExtractedDocument } from "../../core/pages.js";
import type { OperationOptions } from "../../shared/operation.js";

export type ExtractionInput = {
  fileName: string;
  mimeType: string;
  data: Buffer;
};

/** Turns an uploaded file (PDF, Markdown, plain text) into raw text, with page information where the format has pages. */
export interface DocumentTextExtractor {
  /** Throws ValidationError when the file cannot be read. */
  extract(input: ExtractionInput, options?: OperationOptions): Promise<ExtractedDocument>;
}
