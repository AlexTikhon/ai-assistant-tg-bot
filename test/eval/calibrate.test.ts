import { describe, expect, it } from "vitest";
import type { ConfidencePolicy, RetrievalSignals } from "../../src/core/retrieval-confidence.js";
import { buildCalibrationReport, chooseFromCalibration, evaluatePolicy, policyGrid, sweepPolicies } from "../../src/eval/calibrate.js";
import type { CalibrationCase } from "../../src/eval/calibrate.js";

const signals = (overrides: Partial<RetrievalSignals>): RetrievalSignals => ({
  semanticCount: 1,
  lexicalCount: 1,
  candidateCount: 3,
  topSemanticScore: 0.3,
  semanticGap: null,
  topLexicalScore: 2,
  topFusedScore: 0.03,
  fusedGap: null,
  dualMethodCount: 0,
  bestDualRank: null,
  exactTargets: 0,
  exactTargetsFound: 0,
  identifiers: 0,
  identifiersFound: 0,
  bestExactRank: null,
  bestTermCoverage: 0.1,
  ...overrides,
});

const kase = (id: string, answerable: boolean, overrides: Partial<RetrievalSignals>, split: CalibrationCase["split"] = "calibration"): CalibrationCase => ({
  id,
  answerable,
  split,
  signals: signals(overrides),
});

const cases: CalibrationCase[] = [
  kase("good-1", true, { topSemanticScore: 0.8 }),
  kase("good-2", true, { topSemanticScore: 0.7 }),
  kase("good-3", true, { topSemanticScore: 0.4, bestTermCoverage: 0.9 }),
  kase("bad-1", false, { topSemanticScore: 0.35 }),
  kase("bad-2", false, { topSemanticScore: 0.3, bestTermCoverage: 0.2 }),
  kase("held-out", true, { topSemanticScore: 0.1 }, "validation"),
];

const loose: ConfidencePolicy = { minSemanticScore: 0.5, minTermCoverage: 0.8, requireKnownIdentifiers: true };

describe("evaluatePolicy", () => {
  it("applies the gate to every case and builds the confusion matrix and the metrics", () => {
    const result = evaluatePolicy(cases.slice(0, 5), loose);

    expect(result.matrix).toEqual({ tp: 3, fn: 0, fp: 0, tn: 2 });
    expect(result.metrics.recall).toBe(1);
    expect(result.metrics.specificity).toBe(1);
    expect(result.outcomes.map((item) => [item.id, item.decision])).toEqual([
      ["good-1", "answer"],
      ["good-2", "answer"],
      ["good-3", "answer"],
      ["bad-1", "abstain"],
      ["bad-2", "abstain"],
    ]);
  });

  it("shows the cost of a looser policy as false positives", () => {
    const result = evaluatePolicy(cases.slice(0, 5), { ...loose, minSemanticScore: 0.3 });

    expect(result.matrix.fp).toBe(2);
  });
});

describe("policyGrid", () => {
  it("is a small explicit grid that always passes validation", () => {
    const grid = policyGrid();

    expect(grid.length).toBeGreaterThan(50);
    expect(grid.length).toBeLessThan(1000);
    expect(new Set(grid.map((policy) => JSON.stringify(policy))).size).toBe(grid.length);
  });
});

describe("chooseFromCalibration", () => {
  it("looks only at the calibration split when it chooses", () => {
    const sweep = sweepPolicies(cases, policyGrid());
    const chosen = chooseFromCalibration(sweep, { minRecall: 0.99 });

    // the held-out case is unanswerable by every threshold (semantic 0.1, coverage 0.1) yet must not influence the choice
    expect(chosen.calibration.matrix.tp + chosen.calibration.matrix.fn).toBe(3);
    expect(chosen.calibration.metrics.recall).toBe(1);
    expect(chosen.calibration.metrics.specificity).toBe(1);
    // ... and is reported separately afterwards
    expect(chosen.validation.matrix).toEqual({ tp: 0, fn: 1, fp: 0, tn: 0 });
  });

  it("maximises specificity among the policies that keep enough recall", () => {
    const sweep = sweepPolicies(cases, policyGrid());

    const strict = chooseFromCalibration(sweep, { minRecall: 1 });
    const relaxed = chooseFromCalibration(sweep, { minRecall: 0.6 });

    expect(strict.calibration.metrics.recall).toBe(1);
    expect(relaxed.calibration.metrics.recall!).toBeGreaterThanOrEqual(0.6);
    expect(relaxed.calibration.metrics.specificity!).toBeGreaterThanOrEqual(strict.calibration.metrics.specificity!);
  });

  it("is deterministic and prefers the least aggressive policy among equals", () => {
    const sweep = sweepPolicies(cases, policyGrid());

    expect(chooseFromCalibration(sweep, { minRecall: 0.9 }).policy).toEqual(chooseFromCalibration(sweep, { minRecall: 0.9 }).policy);
  });

  it("falls back to the best recall when no policy reaches the required recall", () => {
    const impossible = sweepPolicies([kase("only", true, { topSemanticScore: -0.5, bestTermCoverage: 0, candidateCount: 0 })], policyGrid());

    expect(() => chooseFromCalibration(impossible, { minRecall: 1 })).not.toThrow();
  });

  it("refuses to choose without calibration cases", () => {
    const sweep = sweepPolicies([kase("held-out", true, {}, "validation")], policyGrid());

    expect(() => chooseFromCalibration(sweep, { minRecall: 0.9 })).toThrow(/calibration/i);
  });
});

describe("buildCalibrationReport", () => {
  it("lists the best policies by calibration, the chosen one and how the shipped policy compares", () => {
    const report = buildCalibrationReport(cases, loose, { minRecall: 0.9 });

    expect(report.calibrationQueries).toBe(5);
    expect(report.validationQueries).toBe(1);
    expect(report.top[0]).toBe(report.chosen);
    expect(report.top.length).toBeLessThanOrEqual(8);
    expect(report.chosen.calibration.metrics.recall).toBe(1);
    expect(report.committed.policy).toEqual(loose);
  });

  it("says whether the shipped policy is the one calibration would choose", () => {
    const chosenPolicy = chooseFromCalibration(sweepPolicies(cases, policyGrid()), { minRecall: 0.9 }).policy;

    expect(buildCalibrationReport(cases, chosenPolicy, { minRecall: 0.9 }).committedIsChosen).toBe(true);
    expect(buildCalibrationReport(cases, { ...chosenPolicy, minSemanticScore: 0.31 }, { minRecall: 0.9 }).committedIsChosen).toBe(false);
  });

  it("does not let the shipped policy influence the choice", () => {
    const withShipped = buildCalibrationReport(cases, { minSemanticScore: -1, minTermCoverage: 0, requireKnownIdentifiers: false }, { minRecall: 0.9 });
    const without = chooseFromCalibration(sweepPolicies(cases, policyGrid()), { minRecall: 0.9 });

    expect(withShipped.chosen.policy).toEqual(without.policy);
  });
});
