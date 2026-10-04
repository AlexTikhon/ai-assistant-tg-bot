import { describe, expect, it } from "vitest";
import { buildDocumentText, pageRangeForSpan } from "../../src/core/pages.js";
import { splitText, splitTextWithOffsets } from "../../src/core/text-splitter.js";

const filler = (label: string, sentences: number) =>
  Array.from({ length: sentences }, (_, i) => `${label} sentence number ${i + 1} explains one detail.`).join(" ");

describe("splitTextWithOffsets", () => {
  it("returns the same chunks as splitText, plus where each one came from", () => {
    const text = `${filler("Alpha", 30)}\n\n${filler("Beta", 30)}\n\n${filler("Gamma", 5)}`;
    const options = { chunkSize: 300, chunkOverlap: 60 };

    const positioned = splitTextWithOffsets(text, options);

    expect(positioned.map(({ chunkIndex, content }) => ({ chunkIndex, content }))).toEqual(splitText(text, options));
    expect(positioned.length).toBeGreaterThan(3);
  });

  it("offsets always slice back to exactly the chunk text (overlap, hard splits, emoji, odd whitespace)", () => {
    const samples = [
      `${filler("A", 25)}\n\n${filler("B", 25)}`,
      `${"x".repeat(900)} tail words here`,
      `${"😀".repeat(80)}\n\n${filler("C", 10)}`,
      `  leading space\n\n\n${filler("D", 12)}  `,
    ];

    for (const text of samples) {
      for (const [chunkSize, chunkOverlap] of [
        [200, 0],
        [200, 50],
        [97, 30],
      ]) {
        for (const chunk of splitTextWithOffsets(text, { chunkSize, chunkOverlap })) {
          expect(text.slice(chunk.start, chunk.end)).toBe(chunk.content);
        }
      }
    }
  });
});

describe("buildDocumentText", () => {
  it("normalizes plain text without page information", () => {
    expect(buildDocumentText({ text: "a  b\r\n\r\n\r\n\r\nc" })).toEqual({ text: "a b\n\nc", pageSpans: undefined });
  });

  it("joins pages with a paragraph break, drops empty pages and records each page's span", () => {
    const { text, pageSpans } = buildDocumentText({
      text: "ignored when pages are present",
      pages: [
        { pageNumber: 1, text: "First   page" },
        { pageNumber: 2, text: "   " },
        { pageNumber: 3, text: "Third page" },
      ],
    });

    expect(text).toBe("First page\n\nThird page");
    expect(pageSpans).toEqual([
      { pageNumber: 1, start: 0, end: 10 },
      { pageNumber: 3, start: 12, end: 22 },
    ]);
    expect(text.slice(12, 22)).toBe("Third page");
  });
});

describe("pageRangeForSpan", () => {
  const spans = [
    { pageNumber: 7, start: 0, end: 100 },
    { pageNumber: 8, start: 102, end: 200 },
    { pageNumber: 9, start: 202, end: 300 },
  ];

  it("a span wholly inside one page maps to that page only", () => {
    expect(pageRangeForSpan(spans, 10, 90)).toEqual({ pageStart: 7, pageEnd: 7 });
    expect(pageRangeForSpan(spans, 102, 200)).toEqual({ pageStart: 8, pageEnd: 8 });
  });

  it("a span crossing a page break maps to the real range", () => {
    expect(pageRangeForSpan(spans, 80, 150)).toEqual({ pageStart: 7, pageEnd: 8 });
    expect(pageRangeForSpan(spans, 50, 250)).toEqual({ pageStart: 7, pageEnd: 9 });
  });

  it("is undefined when there are no pages (text files) or the span is empty", () => {
    expect(pageRangeForSpan(undefined, 0, 10)).toBeUndefined();
    expect(pageRangeForSpan([], 0, 10)).toBeUndefined();
    expect(pageRangeForSpan(spans, 20, 20)).toBeUndefined();
  });
});

describe("page provenance of chunks", () => {
  const pages = [
    { pageNumber: 1, text: filler("Intro", 6) },
    { pageNumber: 2, text: filler("Middle", 6) },
    { pageNumber: 3, text: filler("Closing", 6) },
  ];

  function provenance(chunkSize: number, chunkOverlap = 0) {
    const { text, pageSpans } = buildDocumentText({ text: "", pages });
    return splitTextWithOffsets(text, { chunkSize, chunkOverlap }).map((chunk) => ({
      content: chunk.content,
      ...pageRangeForSpan(pageSpans, chunk.start, chunk.end),
    }));
  }

  it("a chunk wholly inside one page cites that single page", () => {
    const chunks = provenance(120);
    const intro = chunks.find((chunk) => chunk.content.startsWith("Intro sentence number 1 "));

    expect(intro).toMatchObject({ pageStart: 1, pageEnd: 1 });
  });

  it("a chunk spanning two pages cites the actual range", () => {
    const [first] = provenance(600); // a page is ~275 characters, so this must cross a page break

    expect(first.content).toContain("Intro sentence number 1 ");
    expect(first.content).toContain("Middle sentence number 1 ");
    expect(first).toMatchObject({ pageStart: 1, pageEnd: 2 });
  });

  it("several chunks of one page all point to that page, in order", () => {
    const chunks = provenance(100);
    const middle = chunks.filter((chunk) => chunk.pageStart === 2 && chunk.pageEnd === 2);

    expect(middle.length).toBeGreaterThanOrEqual(2);
    expect(chunks.every((chunk) => chunk.pageStart !== undefined && chunk.pageEnd! >= chunk.pageStart!)).toBe(true);
    const starts = chunks.map((chunk) => chunk.pageStart!);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("never invents a page: the range always lies within the pages that exist", () => {
    for (const chunk of provenance(250, 50)) {
      expect(chunk.pageStart).toBeGreaterThanOrEqual(1);
      expect(chunk.pageEnd).toBeLessThanOrEqual(3);
    }
  });
});
