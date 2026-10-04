import { PDFParse } from "pdf-parse";
import type { DocumentTextExtractor, ExtractionInput } from "../../application/ports/text-extractor.js";
import type { ExtractedDocument } from "../../core/pages.js";
import { ValidationError } from "../../shared/errors.js";
import { getFileExtension } from "../../shared/utils/path.js";

/**
 * Extracts raw text from PDF, Markdown and plain-text uploads. PDFs additionally return the text of
 * every page under its real page number. Changing what comes out of here changes what gets indexed:
 * bump PDF_EXTRACTOR_VERSION / TEXT_EXTRACTOR_VERSION (core/index-profile.ts) when you do.
 */
export class FileTextExtractor implements DocumentTextExtractor {
  async extract(input: ExtractionInput): Promise<ExtractedDocument> {
    const extension = getFileExtension(input.fileName);

    if (extension === ".pdf") {
      return extractPdf(input.data);
    }

    if (extension === ".md" || extension === ".txt") {
      return { text: input.data.toString("utf-8") };
    }

    throw new ValidationError("Unsupported file type. Send PDF, MD, or TXT.");
  }
}

async function extractPdf(data: Buffer): Promise<ExtractedDocument> {
  const parser = new PDFParse({ data: new Uint8Array(data) });

  try {
    // pageJoiner "": by default pdf-parse appends "-- n of m --" to every page, which would otherwise be indexed as content.
    const result = await parser.getText({ pageJoiner: "" });
    return { text: result.text, pages: result.pages.map((page) => ({ pageNumber: page.num, text: page.text })) };
  } catch (error) {
    throw new ValidationError("Could not read the PDF. The file may be corrupted or password-protected.", {
      cause: error,
    });
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
