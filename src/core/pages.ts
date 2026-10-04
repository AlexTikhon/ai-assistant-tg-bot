import { normalizeText } from "../shared/utils/text.js";

/** Text of one source page, as found in the original file. */
export type SourcePage = { pageNumber: number; text: string };

/** Where a page's text sits inside the combined document text (end exclusive). */
export type PageSpan = { pageNumber: number; start: number; end: number };

export type ExtractedDocument = {
  text: string;
  /** Present only for formats that have pages (PDF). Real page numbers as printed by the file, 1-based. */
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
    pageSpans.push({ pageNumber: page.pageNumber, start: text.length, end: text.length + pageText.length });
    text += pageText;
  }

  return { text, pageSpans };
}

/**
 * The pages a character range [start, end) touches, or undefined when there is nothing to report
 * (no page information, or an empty range). A range inside one page gives pageStart === pageEnd.
 */
export function pageRangeForSpan(
  spans: readonly PageSpan[] | undefined,
  start: number,
  end: number,
): { pageStart: number; pageEnd: number } | undefined {
  if (!spans || end <= start) {
    return undefined;
  }

  const touched = spans.filter((span) => span.start < end && span.end > start);
  if (touched.length === 0) {
    return undefined;
  }

  return { pageStart: touched[0].pageNumber, pageEnd: touched[touched.length - 1].pageNumber };
}
