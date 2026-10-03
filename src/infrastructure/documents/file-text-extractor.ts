import { PDFParse } from "pdf-parse";
import type { DocumentTextExtractor, ExtractionInput } from "../../application/ports/text-extractor.js";
import { ValidationError } from "../../shared/errors.js";
import { getFileExtension } from "../../shared/utils/path.js";

/** Extracts raw text from PDF, Markdown and plain-text uploads. */
export class FileTextExtractor implements DocumentTextExtractor {
  async extract(input: ExtractionInput) {
    const extension = getFileExtension(input.fileName);

    if (extension === ".pdf") {
      return extractPdfText(input.data);
    }

    if (extension === ".md" || extension === ".txt") {
      return input.data.toString("utf-8");
    }

    throw new ValidationError("Unsupported file type. Send PDF, MD, or TXT.");
  }
}

async function extractPdfText(data: Buffer) {
  const parser = new PDFParse({ data: new Uint8Array(data) });

  try {
    const result = await parser.getText();
    return result.text;
  } catch (error) {
    throw new ValidationError("Could not read the PDF. The file may be corrupted or password-protected.", {
      cause: error,
    });
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}
