import { describe, expect, it } from "vitest";
import { answerabilityMetrics, confusionMatrix, median, summarizeSignals } from "../../src/eval/answerability.js";
import type { RetrievalSignals } from "../../src/core/retrieval-confidence.js";

const outcome = (answerable: boolean, decision: "answer" | "abstain") => ({ answerable, decision });

describe("confusionMatrix", () => {
  it("counts allowed answerable questions as TP, rejected answerable as FN, allowed unanswerable as FP, rejected unanswerable as TN", () => {
    const matrix = confusionMatrix([
      outcome(true, "answer"),
      outcome(true, "answer"),
      outcome(true, "answer"),
      outcome(true, "abstain"),
      outcome(false, "answer"),
      outcome(false, "abstain"),
      outcome(false, "abstain"),
      outcome(false, "abstain"),
      outcome(false, "abstain"),
    ]);

    expect(matrix).toEqual({ tp: 3, fn: 1, fp: 1, tn: 4 });
  });

  it("is all zero for no cases", () => {
    expect(confusionMatrix([])).toEqual({ tp: 0, fn: 0, fp: 0, tn: 0 });
  });
});

describe("answerabilityMetrics", () => {
  it("computes precision, recall, specificity and the two error rates", () => {
    const metrics = answerabilityMetrics({ tp: 8, fn: 2, fp: 3, tn: 7 });

    expect(metrics.precision).toBeCloseTo(8 / 11);
    expect(metrics.recall).toBeCloseTo(0.8);
    expect(metrics.specificity).toBeCloseTo(0.7);
    expect(metrics.falsePositiveRate).toBeCloseTo(0.3);
    expect(metrics.falseNegativeRate).toBeCloseTo(0.2);
    expect(metrics).toMatchObject({ tp: 8, fn: 2, fp: 3, tn: 7 });
  });

  it("makes recall and FNR complementary, and specificity and FPR", () => {
    const metrics = answerabilityMetrics({ tp: 5, fn: 3, fp: 4, tn: 9 });

    expect(metrics.recall! + metrics.falseNegativeRate!).toBeCloseTo(1);
    expect(metrics.specificity! + metrics.falsePositiveRate!).toBeCloseTo(1);
  });

  it("reports null instead of NaN when a rate has no cases behind it", () => {
    expect(answerabilityMetrics({ tp: 0, fn: 0, fp: 0, tn: 0 })).toMatchObject({
      precision: null,
      recall: null,
      specificity: null,
      falsePositiveRate: null,
      falseNegativeRate: null,
    });
    // nothing was ever allowed through: precision is undefined, recall is 0
    expect(answerabilityMetrics({ tp: 0, fn: 4, fp: 0, tn: 6 })).toMatchObject({ precision: null, recall: 0, specificity: 1 });
    // only answerable questions: no specificity
    expect(answerabilityMetrics({ tp: 3, fn: 1, fp: 0, tn: 0 })).toMatchObject({ specificity: null, falsePositiveRate: null });
  });

  it("is JSON-safe", () => {
    const text = JSON.stringify(answerabilityMetrics({ tp: 0, fn: 0, fp: 0, tn: 0 }));

    expect(text).not.toMatch(/NaN|Infinity/);
    expect(JSON.parse(text).precision).toBeNull();
  });
});

describe("median", () => {
  it("handles odd, even and empty input", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("summarizeSignals", () => {
  const signals = (overrides: Partial<RetrievalSignals>): RetrievalSignals => ({
    semanticCount: 0,
    lexicalCount: 0,
    candidateCount: 1,
    topSemanticScore: null,
    semanticGap: null,
    topLexicalScore: null,
    topFusedScore: 0.03,
    fusedGap: null,
    dualMethodCount: 0,
    bestDualRank: null,
    exactTargets: 0,
    exactTargetsFound: 0,
    identifiers: 0,
    identifiersFound: 0,
    bestExactRank: null,
    bestTermCoverage: 0,
    ...overrides,
  });

  it("summarises medians and shares over a group of questions, ignoring missing values for medians", () => {
    const summary = summarizeSignals([
      signals({ semanticCount: 2, topSemanticScore: 0.8, topFusedScore: 0.03, lexicalCount: 2, dualMethodCount: 1, bestTermCoverage: 0.5 }),
      signals({ semanticCount: 1, topSemanticScore: 0.4, topFusedScore: 0.02, lexicalCount: 0, dualMethodCount: 0, bestTermCoverage: 0.1 }),
      signals({ topSemanticScore: null, topFusedScore: 0.01, lexicalCount: 1, exactTargets: 1, exactTargetsFound: 1, bestTermCoverage: 0.9 }),
    ]);

    expect(summary.cases).toBe(3);
    expect(summary.medianTopSemanticScore).toBeCloseTo(0.6);
    expect(summary.medianTopFusedScore).toBeCloseTo(0.02);
    expect(summary.medianTermCoverage).toBeCloseTo(0.5);
    expect(summary.withSemanticHit).toBeCloseTo(2 / 3);
    expect(summary.withLexicalHit).toBeCloseTo(2 / 3);
    expect(summary.withDualMethodHit).toBeCloseTo(1 / 3);
    expect(summary.withExactTokenHit).toBeCloseTo(1 / 3);
  });

  it("returns nulls for an empty group", () => {
    expect(summarizeSignals([])).toMatchObject({
      cases: 0,
      medianTopSemanticScore: null,
      withLexicalHit: null,
      withDualMethodHit: null,
    });
  });
});
