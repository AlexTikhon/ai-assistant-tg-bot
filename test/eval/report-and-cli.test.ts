import { describe, expect, it } from "vitest";
import { parseEvalArgs } from "../../src/cli/eval-cli.js";
import { DEFAULT_CONFIDENCE_POLICY } from "../../src/core/retrieval-confidence.js";
import type { RetrievalSignals } from "../../src/core/retrieval-confidence.js";
import { answerabilityMetrics, confusionMatrix, summarizeSignals } from "../../src/eval/answerability.js";
import { aggregateCases } from "../../src/eval/metrics.js";
import { formatBaselineResult, formatComparison, formatEvalReport } from "../../src/eval/report.js";
import type { CaseResult, EvalReport } from "../../src/eval/runner.js";
import type { ComparisonResult } from "../../src/eval/compare.js";

const settings = { topK: 5, minScore: 0.2, semanticLimit: 20, lexicalLimit: 20, rrfK: 60, contextMaxChars: 6000 };

const baseSignals: RetrievalSignals = {
  semanticCount: 4,
  lexicalCount: 3,
  candidateCount: 6,
  topSemanticScore: 0.63,
  semanticGap: 0.18,
  topLexicalScore: 5.96,
  topFusedScore: 0.0315,
  fusedGap: 0.0042,
  dualMethodCount: 2,
  bestDualRank: 1,
  exactTargets: 1,
  exactTargetsFound: 1,
  identifiers: 1,
  identifiersFound: 1,
  bestExactRank: 2,
  bestTermCoverage: 0.75,
};

const hitCase: CaseResult = {
  id: "error-econnreset",
  question: "Why does the cat feed fail with ECONNRESET?",
  user: "alice",
  tags: ["exact-term"],
  split: "calibration",
  expectedSources: [{ document: "ops.md", contains: "ECONNRESET means" }],
  answerable: true,
  expectedSourceRank: 2,
  signals: baseSignals,
  decision: "answer",
  reason: "exact-token",
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
  split: "validation",
  expectedSourceRank: 6,
  signals: { ...baseSignals, semanticCount: 0, topSemanticScore: null, semanticGap: null, dualMethodCount: 0, bestDualRank: null, bestExactRank: 6 },
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
  expectedSourceRank: null,
  signals: { ...baseSignals, exactTargets: 0, exactTargetsFound: 0, identifiers: 0, identifiersFound: 0, bestExactRank: null, bestTermCoverage: 0.5 },
  decision: "answer",
  reason: "term-coverage",
};

function report(cases: CaseResult[]): EvalReport {
  const metrics = (items: CaseResult[]) =>
    aggregateCases(items.map((item) => ({ ranks: item.matchRanks, candidateRanks: item.candidateMatchRanks })), [1, 3, 5]);
  const gate = (items: CaseResult[]) => answerabilityMetrics(confusionMatrix(items));
  const exactTerm = cases.filter((item) => item.tags.includes("exact-term"));
  const split = (name: CaseResult["split"]) => {
    const items = cases.filter((item) => item.split === name);
    return { queries: items.length, retrieval: metrics(items), answerability: gate(items) };
  };
  return {
    settings,
    ks: [1, 3, 5],
    cases,
    overall: metrics(cases),
    byTag: { "exact-term": { ...metrics(exactTerm), queries: exactTerm.length, answerability: gate(exactTerm) } },
    termCoverage: 1,
    noAnswer: { cases: 1, withContext: 1 },
    isolationViolations: 0,
    policy: DEFAULT_CONFIDENCE_POLICY,
    answerability: gate(cases),
    bySplit: { calibration: split("calibration"), validation: split("validation") },
    signals: {
      answerable: summarizeSignals(cases.filter((item) => item.answerable).map((item) => item.signals)),
      unanswerable: summarizeSignals(cases.filter((item) => !item.answerable).map((item) => item.signals)),
    },
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

describe("formatEvalReport: answerability", () => {
  const info = {
    embeddings: { model: "eval-lexicon-v1", live: false },
    dataset: { version: 2, file: "eval/datasets/retrieval.jsonl", documents: 17, queries: 3, answerable: 2, unanswerable: 1, bySplit: { calibration: { queries: 2, answerable: 1, unanswerable: 1 }, validation: { queries: 1, answerable: 1, unanswerable: 0 } } },
    index: { fingerprint: "abc123def456", profile: {} as never, chunks: 45 },
  };
  const text = formatEvalReport(report([hitCase, missCase, noAnswerCase]), { verbose: false, info });

  it("names the dataset version, its size and the index fingerprint so that results can be compared over time", () => {
    expect(text).toContain("Dataset: version 2");
    expect(text).toContain("3 queries (2 answerable, 1 unanswerable)");
    expect(text).toContain("Index fingerprint: abc123def456");
  });

  it("prints the policy, the confusion matrix and the rates", () => {
    expect(text).toContain("Answerability gate");
    expect(text).toContain("minSemanticScore=0.5");
    expect(text).toMatch(/TP 2\s+FN 0\s+FP 1\s+TN 0/);
    expect(text).toMatch(/precision\s+0\.67/);
    expect(text).toMatch(/recall\s+1\.00/);
    expect(text).toMatch(/false-positive rate\s+1\.00/);
    expect(text).toMatch(/specificity\s+0\.00/);
  });

  it("prints n/a, not NaN, for a rate without cases behind it", () => {
    const answerableOnly = formatEvalReport(report([hitCase]), { verbose: false });

    expect(answerableOnly).toMatch(/specificity\s+n\/a/);
    expect(answerableOnly).not.toContain("NaN");
  });

  it("reports calibration and validation separately and says which one is for choosing", () => {
    expect(text).toMatch(/Calibration split \(2 queries\)/);
    expect(text).toMatch(/Validation split \(1 queries\)/);
    expect(text).toContain("validation is only reported, never used to choose");
  });

  it("compares the evidence of answerable and unanswerable questions", () => {
    expect(text).toContain("Evidence by group");
    expect(text).toMatch(/median top semantic score\s+0\.63\s+0\.63/);
    expect(text).toMatch(/with lexical hit\s+100%\s+100%/);
  });

  it("shows the gate decision of every question", () => {
    expect(text).toContain("gate: answer (exact-token)");
    expect(text).toContain("gate: answer (term-coverage)");
  });

  it("verbose mode lists the evidence signals of a question, including where the expected source ranked", () => {
    const verbose = formatEvalReport(report([missCase]), { verbose: true });

    expect(verbose).toContain("top semantic score: -");
    expect(verbose).toContain("lexical matches: 3 (top score 5.96)");
    expect(verbose).toContain("top RRF score: 0.0315 (gap 0.0042)");
    expect(verbose).toContain("dual-method candidates: 0");
    expect(verbose).toContain("exact targets: 1 asked, 1 found");
    expect(verbose).toContain("expected source rank: 6");
    expect(text).not.toContain("top RRF score: ");
  });

  it("adds the gate counts to the tag table", () => {
    expect(text).toMatch(/exact-term\s+2\s+.*TP\s*2/s);
  });
});

describe("formatComparison", () => {
  const result = (name: string, over: Partial<ComparisonResult["settings"]>, recall: number, mrr: number): ComparisonResult => ({
    name,
    settings: { chunkSize: 1000, chunkOverlap: 150, ...settings, ...over },
    chunkCount: 45,
    documentCount: 17,
    profile: {} as never,
    fingerprint: "abc123def456",
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
      calibrate: false,
      dryRun: false,
      confirmSpend: false,
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

  it("reads the ranking variant and confidence policy options", () => {
    expect(
      parseEvalArgs(["--semantic-weight", "1.5", "--lexical-weight", "2", "--exact-token-bonus", "1", "--min-semantic-score", "0.4", "--min-term-coverage", "0.7"]),
    ).toMatchObject({
      kind: "run",
      overrides: { semanticWeight: 1.5, lexicalWeight: 2, exactTokenBonus: 1, confidence: { minSemanticScore: 0.4, minTermCoverage: 0.7 } },
    });
  });

  it("rejects out-of-range ranking and policy values", () => {
    expect(parseEvalArgs(["--lexical-weight", "-1"])).toMatchObject({ kind: "error", message: expect.stringContaining("--lexical-weight") });
    expect(parseEvalArgs(["--min-semantic-score", "2"])).toMatchObject({ kind: "error", message: expect.stringContaining("--min-semantic-score") });
    expect(parseEvalArgs(["--min-term-coverage", "1.5"])).toMatchObject({ kind: "error" });
  });

  it("supports the calibration mode and the live-run safeguards", () => {
    expect(parseEvalArgs(["--calibrate"])).toMatchObject({ kind: "run", calibrate: true });
    expect(parseEvalArgs(["--live", "--dry-run", "--limit", "5"])).toMatchObject({ kind: "run", live: true, dryRun: true, limit: 5 });
    expect(parseEvalArgs(["--live", "--confirm-spend"])).toMatchObject({ kind: "run", live: true, confirmSpend: true });
  });

  it("refuses to confirm spending on something that does not spend", () => {
    expect(parseEvalArgs(["--confirm-spend"])).toMatchObject({ kind: "error", message: expect.stringMatching(/--live/) });
  });

  it("refuses a dry run of something that is free anyway", () => {
    expect(parseEvalArgs(["--dry-run"])).toMatchObject({ kind: "error", message: expect.stringMatching(/--live/) });
  });

  it("validates --limit", () => {
    expect(parseEvalArgs(["--limit", "0"])).toMatchObject({ kind: "error", message: expect.stringContaining("--limit") });
    expect(parseEvalArgs(["--limit", "many"])).toMatchObject({ kind: "error" });
  });

  it("does not mix calibration with a baseline check or a comparison", () => {
    expect(parseEvalArgs(["--calibrate", "--baseline", "b.json"])).toMatchObject({ kind: "error" });
    expect(parseEvalArgs(["--calibrate", "--compare", "c.json"])).toMatchObject({ kind: "error" });
  });

  it("shows help", () => {
    expect(parseEvalArgs(["--help"])).toEqual({ kind: "help" });
  });
});
