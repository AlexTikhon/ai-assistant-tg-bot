import { normalizeText } from "../shared/utils/text.js";

/**
 * Text of one source page, as found in the original file. `label` is the printed page label ("iii", "7") when
 * the file declares one and the extractor reads it reliably; it is never derived from `pageNumber`.
 */
export type SourcePage = { pageNumber: number; text: string; label?: string };

/** Where a page's text sits inside the combined document text (end exclusive). */
export type PageSpan = { pageNumber: number; start: number; end: number; label?: string };

export type ExtractedDocument = {
  text: string;
  /** Present only for formats that have pages (PDF). Physical page numbers of the file (1-based). */
  pages?: SourcePage[];
};

export type DocumentText = {
  /** Normalized text that gets split into chunks. */
  text: string;
  pageSpans?: PageSpan[];
};

/** Pages are joined by a paragraph break, which the splitter prefers as a boundary but never requires. */
const PAGE_SEPARATOR = "\n\n";

/**
 * Normalizes extracted text for chunking. For paged documents every page is normalized on its own and
 * the pages are concatenated, remembering which character range belongs to which page - that is what
 * lets a chunk later be traced back to its pages without splitting at page boundaries.
 */
export function buildDocumentText(extracted: ExtractedDocument): DocumentText {
  if (!extracted.pages) {
    return { text: normalizeText(extracted.text), pageSpans: undefined };
  }

  let text = "";
  const pageSpans: PageSpan[] = [];

  for (const page of extracted.pages) {
    const pageText = normalizeText(page.text);
    if (!pageText) {
      continue;
    }
    if (text) {
      text += PAGE_SEPARATOR;
    }
    const label = page.label?.trim();
    pageSpans.push({
      pageNumber: page.pageNumber,
      start: text.length,
      end: text.length + pageText.length,
      ...(label ? { label } : {}),
    });
    text += pageText;
  }

  return { text, pageSpans };
}

/**
 * The pages a character range [start, end) touches, or undefined when there is nothing to report
 * (no page information, or an empty range). A range inside one page gives pageStart === pageEnd.
 * The physical numbers are always those of the file; printed labels are added only when both the first
 * and the last page of the range have one.
 */
export function pageRangeForSpan(
  spans: readonly PageSpan[] | undefined,
  start: number,
  end: number,
): { pageStart: number; pageEnd: number; pageLabelStart?: string; pageLabelEnd?: string } | undefined {
  if (!spans || end <= start) {
    return undefined;
  }

  const touched = spans.filter((span) => span.start < end && span.end > start);
  if (touched.length === 0) {
    return undefined;
  }

  const first = touched[0];
  const last = touched[touched.length - 1];
  return {
    pageStart: first.pageNumber,
    pageEnd: last.pageNumber,
    ...(first.label !== undefined && last.label !== undefined ? { pageLabelStart: first.label, pageLabelEnd: last.label } : {}),
  };
}
