import { describe, expect, it } from "vitest";
import type { AnswerQuestionResult } from "../../src/application/use-cases/answer-question.use-case.js";
import { formatSourceLocation } from "../../src/core/citations.js";
import { formatAnswer } from "../../src/telegram/ui/format.js";
import { messages } from "../../src/telegram/ui/messages.js";

type Provenance = { pages?: [number, number]; labels?: [string, string]; section?: string[] };

const source = (rank: number, fileName: string, chunkIndex: number, provenance: Provenance | [number, number] = {}) => {
  const { pages, labels, section } = Array.isArray(provenance) ? ({ pages: provenance } as Provenance) : provenance;
  return {
    documentId: fileName,
    fileName,
    chunkIndex,
    rank,
    score: 0.9,
    ...(pages ? { pageStart: pages[0], pageEnd: pages[1] } : {}),
    ...(labels ? { pageLabelStart: labels[0], pageLabelEnd: labels[1] } : {}),
    ...(section ? { sectionPath: section } : {}),
  };
};

type Answered = Extract<AnswerQuestionResult, { kind: "answered" }>;

const answer = (sources: Answered["sources"]): AnswerQuestionResult => ({
  kind: "answered",
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

  it("shows the Markdown section instead of a chunk number", () => {
    expect(formatSourceLocation({ chunkIndex: 16, sectionPath: ["Authentication", "Refresh tokens"] })).toBe("Authentication > Refresh tokens");
    expect(formatSourceLocation({ chunkIndex: 0, sectionPath: ["Introduction"] })).toBe("Introduction");
  });

  it("falls back to the chunk number when a Markdown chunk has no section (text before the first heading)", () => {
    expect(formatSourceLocation({ chunkIndex: 0, sectionPath: [] })).toBe("chunk 1");
    expect(formatSourceLocation({ chunkIndex: 2, sectionPath: undefined })).toBe("chunk 3");
  });

  it("prefers pages over a section: pages are the more precise place to look", () => {
    expect(formatSourceLocation({ chunkIndex: 3, pageStart: 4, pageEnd: 4, sectionPath: ["A"] })).toBe("p. 4");
  });

  it("keeps long headings readable", () => {
    expect(formatSourceLocation({ chunkIndex: 0, sectionPath: ["x".repeat(200)] })).toBe(`${"x".repeat(59)}…`);

    const deep = formatSourceLocation({
      chunkIndex: 0,
      sectionPath: ["Part one", "Chapter with a rather long descriptive title", "Section that goes on for quite a while", "Subsection with more words than is sensible", "Leaf"],
    });
    expect(deep.startsWith("… > ")).toBe(true);
    expect(deep.endsWith("Leaf")).toBe(true);
    expect(deep.length).toBeLessThanOrEqual(150);
  });

  it("never invents a page label: without a known label the physical page is shown as before", () => {
    expect(formatSourceLocation({ chunkIndex: 0, pageStart: 5, pageEnd: 6 })).toBe("pp. 5–6");
    expect(formatSourceLocation({ chunkIndex: 0, pageStart: 5, pageEnd: 5, pageLabelStart: undefined, pageLabelEnd: undefined })).toBe("p. 5");
  });

  it("shows printed page labels next to the physical pages so that the two can never be confused", () => {
    expect(formatSourceLocation({ chunkIndex: 0, pageStart: 5, pageEnd: 5, pageLabelStart: "iii", pageLabelEnd: "iii" })).toBe("p. iii (PDF p. 5)");
    expect(formatSourceLocation({ chunkIndex: 0, pageStart: 5, pageEnd: 6, pageLabelStart: "iii", pageLabelEnd: "iv" })).toBe("pp. iii–iv (PDF pp. 5–6)");
    expect(formatSourceLocation({ chunkIndex: 0, pageStart: 10, pageEnd: 11, pageLabelStart: "7", pageLabelEnd: "8" })).toBe("pp. 7–8 (PDF pp. 10–11)");
  });

  it("does not repeat itself when the printed label equals the physical page", () => {
    expect(formatSourceLocation({ chunkIndex: 0, pageStart: 5, pageEnd: 6, pageLabelStart: "5", pageLabelEnd: "6" })).toBe("pp. 5–6");
  });

  it("ignores a label that is known for only one end of the range", () => {
    expect(formatSourceLocation({ chunkIndex: 0, pageStart: 5, pageEnd: 6, pageLabelStart: "iii" })).toBe("pp. 5–6");
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

  it("shows the Markdown section, the PDF pages and the text chunk, each in the richest form available", () => {
    const text = formatAnswer(
      answer([
        source(1, "spec.pdf", 3, { pages: [5, 6], labels: ["iii", "iv"] }),
        source(2, "api.md", 17, { section: ["Authentication", "Refresh tokens"] }),
        source(3, "notes.txt", 3),
      ]),
    );

    expect(text).toBe(
      [
        "The answer.",
        "",
        "Sources:",
        "[1] spec.pdf · pp. iii–iv (PDF pp. 5–6)",
        "[2] api.md · Authentication > Refresh tokens",
        "[3] notes.txt · chunk 4",
      ].join("\n"),
    );
  });

  it("answers an abstention with one centralized sentence: no source list, no citations, no claim that the answer does not exist", () => {
    const text = formatAnswer({ kind: "insufficient-evidence", reason: "weak-evidence" });

    expect(text).toBe(messages.insufficientEvidence);
    expect(text).toBe("I couldn't find enough information in your uploaded documents to answer that.");
    expect(text).not.toMatch(/Sources|\[\d+\]|none/);
    expect(text).not.toMatch(/doesn't exist|does not exist|no answer/i);
  });

  it("says the same for every abstention reason, without exposing the internal one", () => {
    for (const reason of ["no-candidates", "identifier-not-found", "weak-evidence"] as const) {
      expect(formatAnswer({ kind: "insufficient-evidence", reason })).toBe(messages.insufficientEvidence);
    }
  });

  it("states when there are no sources", () => {
    expect(formatAnswer(answer([]))).toBe("The answer.\n\nSources:\n- none");
  });

  it("keeps file names with markup characters as plain text", () => {
    expect(formatAnswer(answer([source(1, "[1] <b>x</b>_*.md", 0)]))).toContain("[1] [1] <b>x</b>_*.md · chunk 1");
  });
});
