import { describe, expect, it } from "vitest";
import type { AnswerQuestionResult } from "../../src/application/use-cases/answer-question.use-case.js";
import { formatSourceLocation } from "../../src/core/citations.js";
import { formatAnswer } from "../../src/telegram/ui/format.js";

const source = (rank: number, fileName: string, chunkIndex: number, pages?: [number, number]) => ({
  documentId: fileName,
  fileName,
  chunkIndex,
  rank,
  score: 0.9,
  ...(pages ? { pageStart: pages[0], pageEnd: pages[1] } : {}),
});

const answer = (sources: AnswerQuestionResult["sources"]): AnswerQuestionResult => ({
  answer: "The answer.",
  sources,
  citations: { cited: [], removed: [] },
});

describe("formatSourceLocation", () => {
  it("uses real page numbers when the chunk has them", () => {
    expect(formatSourceLocation({ chunkIndex: 16, pageStart: 8, pageEnd: 8 })).toBe("p. 8");
    expect(formatSourceLocation({ chunkIndex: 3, pageStart: 12, pageEnd: 13 })).toBe("pp. 12–13");
  });

  it("falls back to the 1-based chunk position for text documents and PDFs without page data", () => {
    expect(formatSourceLocation({ chunkIndex: 3 })).toBe("chunk 4");
    expect(formatSourceLocation({ chunkIndex: 0, pageStart: undefined, pageEnd: undefined })).toBe("chunk 1");
  });

  it("never prints a half-known page range", () => {
    expect(formatSourceLocation({ chunkIndex: 5, pageStart: 3 })).toBe("chunk 6");
    expect(formatSourceLocation({ chunkIndex: 5, pageEnd: 3 })).toBe("chunk 6");
  });
});

describe("formatAnswer: Telegram source list", () => {
  it("shows PDF sources with their pages and text sources with their chunk, numbered like the [n] citations", () => {
    const text = formatAnswer(
      answer([
        source(1, "architecture.pdf", 16, [8, 8]),
        source(2, "deployment.pdf", 40, [12, 13]),
        source(3, "notes.md", 3),
      ]),
    );

    expect(text).toBe(
      [
        "The answer.",
        "",
        "Sources:",
        "[1] architecture.pdf · p. 8",
        "[2] deployment.pdf · pp. 12–13",
        "[3] notes.md · chunk 4",
      ].join("\n"),
    );
  });

  it("falls back to chunk numbers for a PDF that was indexed before pages were tracked", () => {
    expect(formatAnswer(answer([source(1, "old.pdf", 11)]))).toContain("[1] old.pdf · chunk 12");
  });

  it("uses the rank of each source, so the list always matches the context the model saw", () => {
    const text = formatAnswer(answer([source(1, "a.md", 0), source(2, "b.md", 1), source(3, "c.md", 2)]));

    expect(text.match(/^\[(\d+)\]/gm)).toEqual(["[1]", "[2]", "[3]"]);
  });

  it("does not leak retrieval internals (scores, ids) to the user", () => {
    const text = formatAnswer(answer([source(1, "a.pdf", 0, [1, 1])]));

    expect(text).not.toContain("0.9");
    expect(text).not.toContain("score");
  });

  it("states when there are no sources", () => {
    expect(formatAnswer(answer([]))).toBe("The answer.\n\nSources:\n- none");
  });

  it("keeps file names with markup characters as plain text", () => {
    expect(formatAnswer(answer([source(1, "[1] <b>x</b>_*.md", 0)]))).toContain("[1] [1] <b>x</b>_*.md · chunk 1");
  });
});
