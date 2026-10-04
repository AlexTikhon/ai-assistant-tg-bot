import { describe, expect, it } from "vitest";
import { findMatchRanks, matchesExpectedSource, parseDataset } from "../../src/eval/dataset.js";
import type { ExpectedSource } from "../../src/eval/dataset.js";

const line = (value: unknown) => JSON.stringify(value);

describe("parseDataset", () => {
  it("reads JSON lines, ignoring blank lines and # comments, and applies defaults", () => {
    const cases = parseDataset(
      [
        "# a comment",
        line({ id: "a", question: "Why ECONNRESET?", expectedSources: [{ document: "ops.md", contains: "ECONNRESET" }] }),
        "",
        line({
          id: "b",
          user: "bob",
          question: "Anything?",
          expectedSources: [],
          expectedTerms: ["x"],
          tags: ["no-answer"],
        }),
      ].join("\n"),
    );

    expect(cases).toEqual([
      {
        id: "a",
        user: "alice",
        question: "Why ECONNRESET?",
        expectedSources: [{ document: "ops.md", contains: "ECONNRESET" }],
        expectedTerms: [],
        tags: [],
      },
      { id: "b", user: "bob", question: "Anything?", expectedSources: [], expectedTerms: ["x"], tags: ["no-answer"] },
    ]);
  });

  it("names the line of an invalid case", () => {
    const text = [line({ id: "ok", question: "q", expectedSources: [] }), "{not json", line({ id: "x" })].join("\n");

    expect(() => parseDataset(text)).toThrow(/line 2/);
    expect(() => parseDataset([line({ id: "ok", question: "q", expectedSources: [] }), line({ id: "x" })].join("\n"))).toThrow(
      /line 2.*question/s,
    );
  });

  it("rejects duplicate ids and sources without any way to identify the chunk", () => {
    const dup = line({ id: "same", question: "q", expectedSources: [] });
    expect(() => parseDataset([dup, dup].join("\n"))).toThrow(/duplicate id "same"/i);
    expect(() =>
      parseDataset(line({ id: "n", question: "q", expectedSources: [{ document: "ops.md" }] })),
    ).toThrow(/contains|chunkHint/);
  });

  it("rejects an empty dataset", () => {
    expect(() => parseDataset("# nothing here\n")).toThrow(/no cases/i);
  });
});

describe("matchesExpectedSource", () => {
  const chunk = { owner: "alice", fileName: "ops.md", chunkIndex: 4, content: "Error  ECONNRESET\nmeans the broker hung up." };

  it("matches by document and a text fragment, ignoring case and whitespace differences", () => {
    expect(matchesExpectedSource(chunk, { document: "ops.md", contains: "econnreset means THE broker" }, "alice")).toBe(true);
    expect(matchesExpectedSource(chunk, { document: "ops.md", contains: "ETIMEDOUT" }, "alice")).toBe(false);
  });

  it("never matches another document or another user's copy of the same text", () => {
    const expected: ExpectedSource = { document: "ops.md", contains: "ECONNRESET" };

    expect(matchesExpectedSource({ ...chunk, fileName: "other.md" }, expected, "alice")).toBe(false);
    expect(matchesExpectedSource({ ...chunk, owner: "bob" }, expected, "alice")).toBe(false);
  });

  it("does not depend on the chunk number when a fragment is given, so re-chunking cannot break the ground truth", () => {
    const expected: ExpectedSource = { document: "ops.md", contains: "ECONNRESET", chunkHint: 4 };

    expect(matchesExpectedSource({ ...chunk, chunkIndex: 9 }, expected, "alice")).toBe(true);
  });

  it("falls back to the chunk number when only a hint exists", () => {
    const expected: ExpectedSource = { document: "ops.md", chunkHint: 4 };

    expect(matchesExpectedSource(chunk, expected, "alice")).toBe(true);
    expect(matchesExpectedSource({ ...chunk, chunkIndex: 5 }, expected, "alice")).toBe(false);
  });
});

describe("findMatchRanks", () => {
  const retrieved = [
    { owner: "alice", fileName: "a.md", chunkIndex: 0, content: "alpha one" },
    { owner: "alice", fileName: "b.md", chunkIndex: 0, content: "beta two" },
    { owner: "alice", fileName: "b.md", chunkIndex: 1, content: "beta three" },
  ];

  it("gives, per expected source, the 1-based rank of the first chunk that satisfies it, or null", () => {
    const ranks = findMatchRanks(
      retrieved,
      [
        { document: "b.md", contains: "beta" },
        { document: "a.md", contains: "alpha" },
        { document: "c.md", contains: "gamma" },
      ],
      "alice",
    );

    expect(ranks).toEqual([2, 1, null]);
  });

  it("is empty when nothing is expected", () => {
    expect(findMatchRanks(retrieved, [], "alice")).toEqual([]);
  });
});
