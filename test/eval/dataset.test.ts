import { describe, expect, it } from "vitest";
import { describeDataset, findMatchRanks, matchesExpectedSource, parseDataset, parseDatasetFile } from "../../src/eval/dataset.js";
import type { ExpectedSource } from "../../src/eval/dataset.js";

const line = (value: unknown) => JSON.stringify(value);

const header = line({ dataset: { version: 3, description: "unit test" } });
const answerableCase = (extra: Record<string, unknown> = {}) => ({
  id: "a",
  split: "calibration",
  answerable: true,
  question: "Why ECONNRESET?",
  expectedSources: [{ document: "ops.md", contains: "ECONNRESET" }],
  ...extra,
});
const noAnswerCase = (extra: Record<string, unknown> = {}) => ({
  id: "n",
  split: "validation",
  answerable: false,
  question: "Anything?",
  expectedSources: [],
  ...extra,
});

describe("parseDatasetFile", () => {
  it("reads JSON lines, ignoring blank lines and # comments, applies defaults and returns the dataset version", () => {
    const dataset = parseDatasetFile(
      [
        "# a comment",
        header,
        line(answerableCase()),
        "",
        line(noAnswerCase({ id: "b", user: "bob", expectedTerms: ["x"], tags: ["no-answer"] })),
      ].join("\n"),
    );

    expect(dataset.version).toBe(3);
    expect(dataset.description).toBe("unit test");
    expect(dataset.cases).toEqual([
      {
        id: "a",
        user: "alice",
        split: "calibration",
        answerable: true,
        question: "Why ECONNRESET?",
        expectedSources: [{ document: "ops.md", contains: "ECONNRESET" }],
        expectedTerms: [],
        tags: [],
      },
      {
        id: "b",
        user: "bob",
        split: "validation",
        answerable: false,
        question: "Anything?",
        expectedSources: [],
        expectedTerms: ["x"],
        tags: ["no-answer"],
      },
    ]);
  });

  it("requires exactly one dataset header with a positive integer version", () => {
    expect(() => parseDatasetFile(line(answerableCase()))).toThrow(/header/i);
    expect(() => parseDatasetFile([header, header, line(answerableCase())].join("\n"))).toThrow(/more than one/i);
    expect(() => parseDatasetFile([line({ dataset: { version: 0 } }), line(answerableCase())].join("\n"))).toThrow(/version/);
    expect(() => parseDatasetFile([line({ dataset: { version: "2" } }), line(answerableCase())].join("\n"))).toThrow(/version/);
  });

  it("makes every case declare whether it is answerable and which split it belongs to", () => {
    const { answerable: _answerable, ...withoutAnswerable } = answerableCase();
    const { split: _split, ...withoutSplit } = answerableCase();

    expect(() => parseDatasetFile([header, line(withoutAnswerable)].join("\n"))).toThrow(/line 2.*answerable/s);
    expect(() => parseDatasetFile([header, line(withoutSplit)].join("\n"))).toThrow(/line 2.*split/s);
    expect(() => parseDatasetFile([header, line(answerableCase({ split: "test" }))].join("\n"))).toThrow(/split/);
  });

  it("keeps the answerable flag and the expected sources consistent", () => {
    expect(() => parseDatasetFile([header, line(answerableCase({ expectedSources: [] }))].join("\n"))).toThrow(
      /answerable.*expected source/is,
    );
    expect(() =>
      parseDatasetFile([header, line(noAnswerCase({ expectedSources: [{ document: "ops.md", contains: "x" }] }))].join("\n")),
    ).toThrow(/not answerable.*expected source|expected source.*not answerable/is);
  });

  it("names the line of an invalid case", () => {
    const text = [header, line(noAnswerCase({ id: "ok" })), "{not json", line({ id: "x" })].join("\n");

    expect(() => parseDatasetFile(text)).toThrow(/line 3/);
    expect(() => parseDatasetFile([header, line(noAnswerCase({ id: "ok" })), line({ id: "x" })].join("\n"))).toThrow(
      /line 3.*question/s,
    );
  });

  it("rejects duplicate ids and sources without any way to identify the chunk", () => {
    const dup = line(noAnswerCase({ id: "same" }));
    expect(() => parseDatasetFile([header, dup, dup].join("\n"))).toThrow(/duplicate id "same"/i);
    expect(() =>
      parseDatasetFile([header, line(answerableCase({ expectedSources: [{ document: "ops.md" }] }))].join("\n")),
    ).toThrow(/contains|chunkHint/);
  });

  it("rejects an empty dataset", () => {
    expect(() => parseDatasetFile(`# nothing here\n${header}\n`)).toThrow(/no cases/i);
  });

  it("parseDataset returns only the cases", () => {
    expect(parseDataset([header, line(noAnswerCase())].join("\n")).map((item) => item.id)).toEqual(["n"]);
  });
});

describe("describeDataset", () => {
  it("counts queries, answerable and unanswerable cases, in total and per split", () => {
    const { cases } = parseDatasetFile(
      [
        header,
        line(answerableCase({ id: "a1" })),
        line(answerableCase({ id: "a2", split: "validation" })),
        line(noAnswerCase({ id: "n1", split: "calibration" })),
        line(noAnswerCase({ id: "n2" })),
        line(noAnswerCase({ id: "n3" })),
      ].join("\n"),
    );

    expect(describeDataset(cases)).toEqual({
      queries: 5,
      answerable: 2,
      unanswerable: 3,
      bySplit: {
        calibration: { queries: 2, answerable: 1, unanswerable: 1 },
        validation: { queries: 3, answerable: 1, unanswerable: 2 },
      },
    });
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
