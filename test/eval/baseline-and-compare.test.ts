import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadToolConfig } from "../../src/config/config.js";
import { checkBaseline, parseBaseline } from "../../src/eval/baseline.js";
import type { Baseline } from "../../src/eval/baseline.js";
import { compareConfigs, parseComparison } from "../../src/eval/compare.js";
import type { EvalCase } from "../../src/eval/dataset.js";
import { LexiconEmbeddings } from "../../src/eval/lexicon-embeddings.js";
import { aggregateCases } from "../../src/eval/metrics.js";
import type { EvalReport, RetrievalSettings } from "../../src/eval/runner.js";
import { DEFAULT_CONFIDENCE_POLICY } from "../../src/core/retrieval-confidence.js";
import { answerabilityMetrics } from "../../src/eval/answerability.js";
import { emptyAnswerability, emptySignalSummary, emptySplits, REPO_ROOT } from "./support.js";

const emptyAggregate = aggregateCases([], [1, 3, 5]);

/** A report with exactly the numbers a test wants; the rest is irrelevant to baseline checking. */
function reportWith(overall: Partial<typeof emptyAggregate>, extra: Partial<EvalReport> = {}): EvalReport {
  return {
    settings: {} as RetrievalSettings,
    ks: [1, 3, 5],
    cases: [],
    overall: { ...emptyAggregate, ...overall },
    byTag: {},
    termCoverage: 1,
    noAnswer: { cases: 0, withContext: 0 },
    isolationViolations: 0,
    policy: DEFAULT_CONFIDENCE_POLICY,
    answerability: emptyAnswerability,
    bySplit: emptySplits(emptyAggregate),
    signals: { answerable: emptySignalSummary, unanswerable: emptySignalSummary },
    ...extra,
  };
}

const baseline: Baseline = {
  config: { chunkSize: 1000, chunkOverlap: 150, topK: 5, minScore: 0.2, semanticLimit: 20, lexicalLimit: 20, rrfK: 60, contextMaxChars: 6000 },
  minimums: { recallAt3: 0.85, mrr: 0.75 },
  tolerance: 0.02,
};

describe("checkBaseline", () => {
  it("passes when every metric is at or above its minimum", () => {
    const result = checkBaseline(reportWith({ recallAt: { 1: 0.7, 3: 0.9, 5: 1 }, mrr: 0.8 }), baseline);

    expect(result.passed).toBe(true);
    expect(result.checks).toEqual([
      { metric: "recallAt3", actual: 0.9, minimum: 0.85, ok: true },
      { metric: "mrr", actual: 0.8, minimum: 0.75, ok: true },
    ]);
  });

  it("tolerates a small drop below the minimum (rounding and one-case noise)", () => {
    const result = checkBaseline(reportWith({ recallAt: { 1: 0, 3: 0.84, 5: 0 }, mrr: 0.74 }), baseline);

    expect(result.passed).toBe(true);
  });

  it("fails when quality falls materially below the baseline, naming the metric", () => {
    const result = checkBaseline(reportWith({ recallAt: { 1: 0, 3: 0.6, 5: 0 }, mrr: 0.8 }), baseline);

    expect(result.passed).toBe(false);
    expect(result.checks.filter((check) => !check.ok).map((check) => check.metric)).toEqual(["recallAt3"]);
  });

  it("always fails on a user-isolation violation, whatever the quality", () => {
    const result = checkBaseline(reportWith({ recallAt: { 1: 1, 3: 1, 5: 1 }, mrr: 1 }, { isolationViolations: 2 }), baseline);

    expect(result.passed).toBe(false);
    expect(result.isolationViolations).toBe(2);
  });

  it("checks a metric of one tag, written tag/metric, so a single broken path cannot hide behind the overall average", () => {
    const withTag = reportWith(
      { recallAt: { 1: 1, 3: 1, 5: 1 }, mrr: 1 },
      { byTag: { "semantic-only": { ...emptyAggregate, queries: 3, answerability: emptyAnswerability, cases: 3, recallAt: { 1: 0, 3: 0.2, 5: 0.2 } } } },
    );
    const result = checkBaseline(withTag, { ...baseline, minimums: { mrr: 0.75, "semantic-only/recallAt3": 0.6 } });

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual([
      { metric: "mrr", actual: 1, minimum: 0.75, ok: true },
      { metric: "semantic-only/recallAt3", actual: 0.2, minimum: 0.6, ok: false },
    ]);
  });

  it("refuses a tag metric for a tag the report does not contain (a typo must not silently pass)", () => {
    expect(() => checkBaseline(reportWith({}), { ...baseline, minimums: { "nope/recallAt3": 0.5 } })).toThrow(/tag "nope"/);
  });

  it("refuses a baseline that asks for a K or metric the report does not have", () => {
    expect(() => checkBaseline(reportWith({}), { ...baseline, minimums: { recallAt7: 0.5 } })).toThrow(/recallAt7/);
    expect(() => checkBaseline(reportWith({}), { ...baseline, minimums: { nonsense: 0.5 } })).toThrow(/nonsense/);
  });
});

describe("checkBaseline: answerability", () => {
  const withGate = (matrix: { tp: number; fn: number; fp: number; tn: number }, extra: Partial<EvalReport> = {}) =>
    reportWith({ recallAt: { 1: 1, 3: 1, 5: 1 }, mrr: 1 }, { answerability: answerabilityMetrics(matrix), ...extra });

  it("guards the recall and the specificity of the confidence gate", () => {
    const minimums = { answerabilityRecall: 0.9, answerabilitySpecificity: 0.7 };

    expect(checkBaseline(withGate({ tp: 19, fn: 1, fp: 3, tn: 9 }), { ...baseline, minimums }).passed).toBe(true);
    // a gate that refuses valid questions
    const refusing = checkBaseline(withGate({ tp: 10, fn: 10, fp: 0, tn: 12 }), { ...baseline, minimums });
    expect(refusing.checks.filter((check) => !check.ok).map((check) => check.metric)).toEqual(["answerabilityRecall"]);
    // a gate that lets everything through
    const open = checkBaseline(withGate({ tp: 20, fn: 0, fp: 12, tn: 0 }), { ...baseline, minimums });
    expect(open.checks.filter((check) => !check.ok).map((check) => check.metric)).toEqual(["answerabilitySpecificity"]);
  });

  it("can restrict an answerability metric to one tag", () => {
    const tagged = withGate(
      { tp: 5, fn: 0, fp: 0, tn: 5 },
      { byTag: { "no-answer": { ...emptyAggregate, queries: 5, answerability: answerabilityMetrics({ tp: 0, fn: 0, fp: 4, tn: 1 }) } } },
    );

    const result = checkBaseline(tagged, { ...baseline, minimums: { "no-answer/answerabilitySpecificity": 0.5 } });

    expect(result.checks).toEqual([{ metric: "no-answer/answerabilitySpecificity", actual: 0.2, minimum: 0.5, ok: false }]);
  });

  it("refuses a metric that is undefined for the run instead of silently passing", () => {
    expect(() => checkBaseline(withGate({ tp: 0, fn: 0, fp: 0, tn: 0 }), { ...baseline, minimums: { answerabilityRecall: 0.5 } })).toThrow(
      /answerabilityRecall.*no/i,
    );
  });
});

describe("parseBaseline", () => {
  it("reads a baseline file and defaults the tolerance", () => {
    const parsed = parseBaseline(JSON.stringify({ config: baseline.config, minimums: { mrr: 0.7 } }));

    expect(parsed.tolerance).toBe(0.02);
    expect(parsed.minimums).toEqual({ mrr: 0.7 });
  });

  it("rejects missing or out-of-range values", () => {
    expect(() => parseBaseline("{}")).toThrow(/config/);
    expect(() => parseBaseline(JSON.stringify({ config: baseline.config, minimums: { mrr: 1.5 } }))).toThrow(/mrr/);
  });
});

describe("the committed baseline", () => {
  it("pins the same configuration the bot ships with, so a changed default has to be a conscious decision here too", async () => {
    const { readFileSync } = await import("node:fs");
    const committed = parseBaseline(readFileSync(path.join(REPO_ROOT, "eval", "baseline.json"), "utf-8"));
    const { chunking, retrieval } = loadToolConfig({});

    expect(committed.config).toEqual({
      chunkSize: chunking.chunkSize,
      chunkOverlap: chunking.chunkOverlap,
      topK: retrieval.topK,
      minScore: retrieval.minScore,
      semanticLimit: retrieval.semanticLimit,
      lexicalLimit: retrieval.lexicalLimit,
      rrfK: retrieval.rrfK,
      contextMaxChars: retrieval.contextMaxChars,
      exactTokenBonus: retrieval.exactTokenBonus,
      confidence: retrieval.confidence,
    });
  });
});

describe("compareConfigs", () => {
  const embeddings = new LexiconEmbeddings({ feeding: ["feeder", "dispenser"], blocked: ["jam", "jammed", "stuck"] });
  const corpus = [
    { owner: "alice", fileName: "feeder.md", content: "Clear a jammed feeder by removing the paddle." },
    { owner: "alice", fileName: "ops.md", content: "ECONNRESET means the broker closed the connection." },
  ];
  const cases: EvalCase[] = [
    {
      id: "semantic",
      user: "alice",
      split: "calibration",
      answerable: true,
      question: "my dispenser is stuck",
      expectedSources: [{ document: "feeder.md", contains: "jammed feeder" }],
      expectedTerms: [],
      tags: [],
    },
    {
      id: "exact",
      user: "alice",
      split: "calibration",
      answerable: true,
      question: "ECONNRESET",
      expectedSources: [{ document: "ops.md", contains: "ECONNRESET means" }],
      expectedTerms: [],
      tags: [],
    },
  ];
  const base = { ...baseline.config, topK: 3 };

  it("runs the same questions under each configuration and reports every one", async () => {
    const results = await compareConfigs({
      corpus,
      cases,
      embeddings,
      base,
      configs: [{ name: "hybrid" }, { name: "vector-only", lexicalLimit: 0 }, { name: "keyword-only", semanticLimit: 0 }],
    });

    expect(results.map((result) => result.name)).toEqual(["hybrid", "vector-only", "keyword-only"]);
    const [hybrid, vectorOnly, keywordOnly] = results.map((result) => result.report.overall);
    expect(hybrid.recallAt[3]).toBe(1);
    expect(keywordOnly.recallAt[3]).toBe(0.5); // shares no word with the paraphrase
    expect(hybrid.recallAt[3]).toBeGreaterThanOrEqual(vectorOnly.recallAt[3]);
    expect(hybrid.mrr).toBeGreaterThanOrEqual(vectorOnly.mrr);
    expect(hybrid.mrr).toBeGreaterThan(keywordOnly.mrr);
    // The ranks the report carries show which method found what.
    const paraphrase = results[1].report.cases[0].firstRelevant;
    expect(paraphrase?.lexicalRank).toBeUndefined();
    expect(results[2].report.cases[0].firstRelevant).toBeNull();
  });

  it("applies only the overrides given and keeps everything else from the base", async () => {
    const [result] = await compareConfigs({ corpus, cases, embeddings, base, configs: [{ name: "k", rrfK: 10, topK: 2 }] });

    expect(result.settings).toEqual({ ...base, rrfK: 10, topK: 2 });
  });

  it("compares ranking variants and confidence policies without re-indexing", async () => {
    const results = await compareConfigs({
      corpus,
      cases,
      embeddings,
      base,
      configs: [
        { name: "rrf" },
        { name: "weighted", lexicalWeight: 2 },
        { name: "bonus", exactTokenBonus: 1 },
        { name: "strict gate", confidence: { minSemanticScore: 0.9 } },
      ],
    });

    expect(results.map((result) => result.chunkCount)).toEqual([2, 2, 2, 2]);
    expect(results[1].settings.lexicalWeight).toBe(2);
    expect(results[2].report.cases[1].retrieved[0].exactMatches).toBe(1);
    // a partial policy override keeps the other fields of the base policy
    expect(results[3].settings.confidence).toEqual({ ...DEFAULT_CONFIDENCE_POLICY, ...baseline.config.confidence, minSemanticScore: 0.9 });
    expect(results[3].report.policy.minSemanticScore).toBe(0.9);
  });

  it("re-indexes only for configurations with a different chunking", async () => {
    const results = await compareConfigs({
      corpus,
      cases,
      embeddings,
      base,
      configs: [{ name: "a" }, { name: "b", rrfK: 20 }, { name: "small chunks", chunkSize: 40, chunkOverlap: 5 }],
    });

    expect(results.map((result) => result.chunkCount)).toEqual([2, 2, expect.any(Number)]);
    expect(results[2].chunkCount).toBeGreaterThan(2);
  });

  it("is reproducible: identical configurations give identical numbers", async () => {
    const run = () => compareConfigs({ corpus, cases, embeddings, base, configs: [{ name: "x" }] });

    expect((await run())[0].report.overall).toEqual((await run())[0].report.overall);
  });
});

describe("parseComparison", () => {
  it("reads named configurations", () => {
    const parsed = parseComparison(
      JSON.stringify({ configs: [{ name: "a" }, { name: "b", rrfK: 40, lexicalLimit: 30 }] }),
    );

    expect(parsed).toEqual([{ name: "a" }, { name: "b", rrfK: 40, lexicalLimit: 30 }]);
  });

  it("reads ranking variants and a partial confidence policy", () => {
    const parsed = parseComparison(
      JSON.stringify({ configs: [{ name: "w", semanticWeight: 1.5, lexicalWeight: 2, exactTokenBonus: 1, confidence: { minTermCoverage: 0.7 } }] }),
    );

    expect(parsed[0]).toMatchObject({ semanticWeight: 1.5, lexicalWeight: 2, exactTokenBonus: 1, confidence: { minTermCoverage: 0.7 } });
  });

  it("rejects negative weights and an out-of-range policy", () => {
    expect(() => parseComparison(JSON.stringify({ configs: [{ name: "a", lexicalWeight: -1 }] }))).toThrow(/lexicalWeight/);
    expect(() => parseComparison(JSON.stringify({ configs: [{ name: "a", confidence: { minSemanticScore: 2 } }] }))).toThrow(/minSemanticScore/);
    expect(() => parseComparison(JSON.stringify({ configs: [{ name: "a", confidence: { nope: 1 } }] }))).toThrow(/nope/);
  });

  it("rejects unknown settings, duplicate names and invalid values", () => {
    expect(() => parseComparison(JSON.stringify({ configs: [{ name: "a", rrfk: 1 }] }))).toThrow(/rrfk/);
    expect(() => parseComparison(JSON.stringify({ configs: [{ name: "a" }, { name: "a" }] }))).toThrow(/duplicate/i);
    expect(() => parseComparison(JSON.stringify({ configs: [{ name: "a", rrfK: 0 }] }))).toThrow(/rrfK/);
    expect(() => parseComparison(JSON.stringify({ configs: [] }))).toThrow(/at least one/i);
  });
});
