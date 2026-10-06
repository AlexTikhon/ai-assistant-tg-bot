import { PDFParse } from "pdf-parse";
import type { DocumentTextExtractor, ExtractionInput } from "../../application/ports/text-extractor.js";
import { findTextProblem, hasPdfSignature } from "../../core/file-validation.js";
import type { TextProblem } from "../../core/file-validation.js";
import type { ExtractedDocument } from "../../core/pages.js";
import { ValidationError } from "../../shared/errors.js";
import { getFileExtension } from "../../shared/utils/path.js";
import type { OperationOptions } from "../../shared/operation.js";

/** More pages than this is refused before any text is extracted (see MAX_PDF_PAGES in the configuration). */
const DEFAULT_MAX_PDF_PAGES = 1000;

const TEXT_PROBLEMS: Record<TextProblem, string> = {
  pdf: "This file is a PDF. Send it with the .pdf extension.",
  binary: "This file looks like binary data, not text. Send a UTF-8 text or Markdown file.",
  "not-utf8": "This text file is not UTF-8 encoded. Save it as UTF-8 and send it again.",
};

export type FileTextExtractorOptions = {
  maxPdfPages?: number;
};

/**
 * Extracts raw text from PDF, Markdown and plain-text uploads. PDFs additionally return the text of
 * every page under its real page number. Changing what comes out of here changes what gets indexed:
 * bump PDF_EXTRACTOR_VERSION / TEXT_EXTRACTOR_VERSION (core/index-profile.ts) when you do.
 *
 * The extension alone is not trusted: a PDF must carry the PDF signature, text must be UTF-8 text and not binary data,
 * and a PDF with more pages than the limit is refused before any page is read.
 */
export class FileTextExtractor implements DocumentTextExtractor {
  private readonly maxPdfPages: number;

  constructor(options: FileTextExtractorOptions = {}) {
    this.maxPdfPages = options.maxPdfPages ?? DEFAULT_MAX_PDF_PAGES;
  }

  async extract(input: ExtractionInput, options: OperationOptions = {}): Promise<ExtractedDocument> {
    options.signal?.throwIfAborted();
    const extension = getFileExtension(input.fileName);

    if (extension === ".pdf") {
      if (!hasPdfSignature(input.data)) {
        throw new ValidationError("This file is named like a PDF but is not a PDF document.");
      }
      return extractPdf(input.data, this.maxPdfPages, options.signal);
    }

    if (extension === ".md" || extension === ".txt") {
      const problem = findTextProblem(input.data);
      if (problem) {
        throw new ValidationError(TEXT_PROBLEMS[problem]);
      }
      return { text: input.data.toString("utf-8") };
    }

    throw new ValidationError("Unsupported file type. Send PDF, MD, or TXT.");
  }
}

async function extractPdf(data: Buffer, maxPages: number, signal?: AbortSignal): Promise<ExtractedDocument> {
  const parser = new PDFParse({ data: new Uint8Array(data) });
  const cancel = () => { void parser.destroy().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });

  try {
    // The page count is read from the document structure first, so a PDF of thousands of (possibly empty) pages costs nothing.
    const { total } = await parser.getInfo();
    signal?.throwIfAborted();
    if (total > maxPages) {
      throw new ValidationError(`This PDF has ${total} pages; the limit is ${maxPages}. Try splitting it.`);
    }

    // pageJoiner "": by default pdf-parse appends "-- n of m --" to every page, which would otherwise be indexed as content.
    const result = await parser.getText({ pageJoiner: "" });
    signal?.throwIfAborted();
    return { text: result.text, pages: result.pages.map((page) => ({ pageNumber: page.num, text: page.text })) };
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ValidationError("Could not read the PDF. The file may be corrupted or password-protected.", {
      cause: error,
    });
  } finally {
    signal?.removeEventListener("abort", cancel);
    await parser.destroy().catch(() => undefined);
  }
}
