import { describe, expect, it } from "vitest";
import { parseEvalArgs } from "../../src/cli/eval-cli.js";
import { aggregateCases } from "../../src/eval/metrics.js";
import { formatBaselineResult, formatComparison, formatEvalReport } from "../../src/eval/report.js";
import type { CaseResult, EvalReport } from "../../src/eval/runner.js";
import type { ComparisonResult } from "../../src/eval/compare.js";

const settings = { topK: 5, minScore: 0.2, semanticLimit: 20, lexicalLimit: 20, rrfK: 60, contextMaxChars: 6000 };

const hitCase: CaseResult = {
  id: "error-econnreset",
  question: "Why does the cat feed fail with ECONNRESET?",
  user: "alice",
  tags: ["exact-term"],
  expectedSources: [{ document: "ops.md", contains: "ECONNRESET means" }],
  answerable: true,
  matchRanks: [2],
  candidateMatchRanks: [2],
  hit: true,
  reciprocalRank: 0.5,
  recallAt: { 1: 0, 3: 1, 5: 1 },
  retrieved: [
    { rank: 1, document: "api.md", owner: "alice", chunkIndex: 0, semanticRank: 1, fusedRank: 1, relevant: false },
    { rank: 2, document: "ops.md", owner: "alice", chunkIndex: 3, semanticRank: 4, lexicalRank: 1, fusedRank: 2, relevant: true },
  ],
  firstRelevant: { rank: 2, document: "ops.md", owner: "alice", chunkIndex: 3, semanticRank: 4, lexicalRank: 1, fusedRank: 2, relevant: true, inContext: true },
  termCoverage: 1,
  isolationViolations: 0,
  lostToSelection: false,
};
const missCase: CaseResult = {
  ...hitCase,
  id: "miss",
  question: "What is E-4012?",
  matchRanks: [null],
  candidateMatchRanks: [6],
  hit: false,
  reciprocalRank: 0,
  recallAt: { 1: 0, 3: 0, 5: 0 },
  firstRelevant: { rank: 6, document: "cat-feeder.md", owner: "alice", chunkIndex: 2, lexicalRank: 1, fusedRank: 6, relevant: true, inContext: false },
  lostToSelection: true,
};
const noAnswerCase: CaseResult = {
  ...hitCase,
  id: "none",
  question: "Capital of Australia?",
  answerable: false,
  expectedSources: [],
  matchRanks: [],
  candidateMatchRanks: [],
  hit: false,
  reciprocalRank: 0,
  recallAt: { 1: 0, 3: 0, 5: 0 },
  firstRelevant: null,
  termCoverage: undefined,
};

function report(cases: CaseResult[]): EvalReport {
  const metrics = (items: CaseResult[]) =>
    aggregateCases(items.map((item) => ({ ranks: item.matchRanks, candidateRanks: item.candidateMatchRanks })), [1, 3, 5]);
  return {
    settings,
    ks: [1, 3, 5],
    cases,
    overall: metrics(cases),
    byTag: { "exact-term": metrics(cases.filter((item) => item.tags.includes("exact-term"))) },
    termCoverage: 1,
    noAnswer: { cases: 1, withContext: 1 },
    isolationViolations: 0,
  };
}

describe("formatEvalReport", () => {
  const text = formatEvalReport(report([hitCase, missCase, noAnswerCase]), { verbose: false });

  it("prints the aggregate metrics", () => {
    expect(text).toContain("Recall@1");
    expect(text).toContain("Recall@3");
    expect(text).toContain("Recall@5");
    expect(text).toContain("MRR");
    expect(text).toContain("HitRate@3");
    expect(text).toMatch(/Recall@3\s+0\.50/);
    expect(text).toMatch(/MRR\s+0\.25/);
  });

  it("shows, per question, the expected source, hit or miss, reciprocal rank and the ranks of each method", () => {
    expect(text).toMatch(/HIT\s+error-econnreset/);
    expect(text).toContain("Why does the cat feed fail with ECONNRESET?");
    expect(text).toContain("expected: ops.md");
    expect(text).toContain("rr 0.50");
    expect(text).toContain("semantic #4");
    expect(text).toContain("lexical #1");
    expect(text).toContain("rrf #2");
  });

  it("explains a miss: where the expected chunk ranked even though it did not reach the context", () => {
    expect(text).toMatch(/MISS\s+miss/);
    expect(text).toContain("not in context (candidate rrf #6, lexical #1)");
  });

  it("reports no-answer questions and the tag breakdown separately", () => {
    expect(text).toContain("No-answer questions: 1 (1 still returned context)");
    expect(text).toContain("exact-term");
  });

  it("verbose mode adds the retrieved list for every question", () => {
    const verbose = formatEvalReport(report([hitCase]), { verbose: true });

    expect(verbose).toContain("1. api.md");
    expect(verbose).toContain("2. ops.md");
    expect(text).not.toContain("1. api.md");
  });

  it("says when an expected source could not be matched at all", () => {
    const lost = formatEvalReport(report([{ ...missCase, firstRelevant: null, candidateMatchRanks: [null] }]), { verbose: false });

    expect(lost).toContain("not retrieved");
  });
});

describe("formatComparison", () => {
  const result = (name: string, over: Partial<ComparisonResult["settings"]>, recall: number, mrr: number): ComparisonResult => ({
    name,
    settings: { chunkSize: 1000, chunkOverlap: 150, ...settings, ...over },
    chunkCount: 45,
    report: {
      ...report([hitCase]),
      overall: { ...report([hitCase]).overall, recallAt: { 1: recall - 0.1, 3: recall, 5: recall }, mrr },
    },
  });

  const text = formatComparison([result("A", {}, 0.87, 0.81), result("B", { semanticLimit: 10, lexicalLimit: 30, rrfK: 40 }, 0.91, 0.85)]);

  it("prints every configuration with its settings and metrics", () => {
    expect(text).toContain("Configuration A");
    expect(text).toContain("semanticLimit=20");
    expect(text).toContain("Configuration B");
    expect(text).toContain("semanticLimit=10");
    expect(text).toContain("lexicalLimit=30");
    expect(text).toContain("rrfK=40");
    expect(text).toMatch(/Recall@3:\s+0\.87/);
    expect(text).toMatch(/MRR:\s+0\.85/);
  });

  it("shows the change against the first configuration", () => {
    expect(text).toMatch(/Recall@3:\s+0\.91 \(\+0\.04\)/);
    expect(text).toMatch(/MRR:\s+0\.85 \(\+0\.04\)/);
  });

  it("ends with a compact table for scanning many configurations at once", () => {
    expect(text).toMatch(/Summary[\s\S]*A[\s\S]*B/);
  });
});

describe("formatBaselineResult", () => {
  it("lists each check and the verdict", () => {
    const text = formatBaselineResult({
      passed: false,
      isolationViolations: 0,
      checks: [
        { metric: "recallAt3", actual: 0.6, minimum: 0.85, ok: false },
        { metric: "mrr", actual: 0.9, minimum: 0.75, ok: true },
      ],
    });

    expect(text).toContain("FAIL recallAt3");
    expect(text).toContain("0.60");
    expect(text).toContain("ok   mrr");
    expect(text).toContain("Retrieval quality is below the baseline");
  });

  it("calls out isolation violations", () => {
    expect(formatBaselineResult({ passed: false, isolationViolations: 3, checks: [] })).toContain("3 chunk(s) of another user");
  });
});

describe("parseEvalArgs", () => {
  it("has useful defaults", () => {
    expect(parseEvalArgs([])).toEqual({
      kind: "run",
      dataset: "eval/datasets/retrieval.jsonl",
      corpus: "eval/corpus",
      verbose: false,
      json: false,
      live: false,
      overrides: {},
    });
  });

  it("reads the options", () => {
    expect(
      parseEvalArgs(["--dataset", "d.jsonl", "--top-k", "3", "--verbose", "--json", "--rrf-k", "40", "--chunk-size", "500", "--min-score", "0.3"]),
    ).toMatchObject({
      kind: "run",
      dataset: "d.jsonl",
      verbose: true,
      json: true,
      overrides: { topK: 3, rrfK: 40, chunkSize: 500, minScore: 0.3 },
    });
  });

  it("supports a comparison file and a baseline check", () => {
    expect(parseEvalArgs(["--compare", "c.json"])).toMatchObject({ kind: "run", compare: "c.json" });
    expect(parseEvalArgs(["--baseline", "b.json"])).toMatchObject({ kind: "run", baseline: "b.json" });
  });

  it("rejects combinations that make no sense", () => {
    expect(parseEvalArgs(["--compare", "c.json", "--baseline", "b.json"])).toMatchObject({ kind: "error" });
    expect(parseEvalArgs(["--live", "--baseline", "b.json"])).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/offline/),
    });
  });

  it("rejects bad numbers and unknown options with a readable message", () => {
    expect(parseEvalArgs(["--top-k", "zero"])).toMatchObject({ kind: "error", message: expect.stringContaining("--top-k") });
    expect(parseEvalArgs(["--top-k", "0"])).toMatchObject({ kind: "error" });
    expect(parseEvalArgs(["--bogus"])).toMatchObject({ kind: "error", message: expect.stringContaining("--bogus") });
  });

  it("shows help", () => {
    expect(parseEvalArgs(["--help"])).toEqual({ kind: "help" });
  });
});
