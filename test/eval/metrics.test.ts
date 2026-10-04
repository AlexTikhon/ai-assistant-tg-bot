import { describe, expect, it } from "vitest";
import { aggregateCases, hitAtK, mean, recallAtK, reciprocalRank } from "../../src/eval/metrics.js";
import type { CaseMetrics } from "../../src/eval/metrics.js";

describe("recallAtK", () => {
  it("is the share of expected sources found within the first K results", () => {
    // Two expected sources: one found at rank 1, one at rank 4.
    expect(recallAtK([1, 4], 1)).toBe(0.5);
    expect(recallAtK([1, 4], 3)).toBe(0.5);
    expect(recallAtK([1, 4], 4)).toBe(1);
    expect(recallAtK([1, 4], 5)).toBe(1);
  });

  it("counts a missing source as not found", () => {
    expect(recallAtK([2, null, null], 5)).toBeCloseTo(1 / 3);
    expect(recallAtK([null], 5)).toBe(0);
  });

  it("is undefined when nothing is expected - such cases are scored separately, not as a perfect or zero recall", () => {
    expect(recallAtK([], 3)).toBeUndefined();
  });

  it("rejects a K below 1", () => {
    expect(() => recallAtK([1], 0)).toThrow(RangeError);
  });
});

describe("hitAtK", () => {
  it("is 1 when any expected source is within the first K, else 0", () => {
    expect(hitAtK([4, null], 3)).toBe(0);
    expect(hitAtK([4, 2], 3)).toBe(1);
    expect(hitAtK([null, null], 10)).toBe(0);
    expect(hitAtK([], 3)).toBeUndefined();
  });
});

describe("reciprocalRank", () => {
  it("is 1 / rank of the first relevant result over all expected sources", () => {
    expect(reciprocalRank([3, null, 1])).toBe(1);
    expect(reciprocalRank([4])).toBe(0.25);
    expect(reciprocalRank([null, 2])).toBe(0.5);
  });

  it("is 0 when nothing relevant was retrieved and undefined when nothing was expected", () => {
    expect(reciprocalRank([null, null])).toBe(0);
    expect(reciprocalRank([])).toBeUndefined();
  });
});

describe("mean", () => {
  it("averages numbers, skipping undefined, and is 0 for an empty list", () => {
    expect(mean([1, 0, 0.5, undefined])).toBe(0.5);
    expect(mean([])).toBe(0);
    expect(mean([undefined])).toBe(0);
  });
});

describe("aggregateCases", () => {
  const metrics = (overrides: Partial<CaseMetrics>): CaseMetrics => ({
    ranks: [1],
    candidateRanks: [1],
    ...overrides,
  });

  it("averages Recall@K, HitRate@K and MRR over answerable cases only", () => {
    const aggregate = aggregateCases(
      [
        metrics({ ranks: [1] }), // recall@1 = 1, rr = 1
        metrics({ ranks: [3] }), // recall@1 = 0, @3 = 1, rr = 1/3
        metrics({ ranks: [null] }), // miss
        metrics({ ranks: [] }), // no answer expected: ignored here
      ],
      [1, 3, 5],
    );

    expect(aggregate.cases).toBe(3);
    expect(aggregate.recallAt).toEqual({ 1: 1 / 3, 3: 2 / 3, 5: 2 / 3 });
    expect(aggregate.hitRateAt).toEqual({ 1: 1 / 3, 3: 2 / 3, 5: 2 / 3 });
    expect(aggregate.mrr).toBeCloseTo((1 + 1 / 3 + 0) / 3);
  });

  it("also scores the candidate list before context selection, to expose evidence lost to diversification", () => {
    const aggregate = aggregateCases(
      [metrics({ ranks: [null], candidateRanks: [2] }), metrics({ ranks: [1], candidateRanks: [1] })],
      [3],
    );

    expect(aggregate.recallAt[3]).toBe(0.5);
    expect(aggregate.candidateRecallAt[3]).toBe(1);
    expect(aggregate.candidateMrr).toBeCloseTo(0.75);
    expect(aggregate.lostToSelection).toBe(1);
  });

  it("returns zeros for an empty set instead of NaN", () => {
    const aggregate = aggregateCases([], [1, 3]);

    expect(aggregate.cases).toBe(0);
    expect(aggregate.mrr).toBe(0);
    expect(aggregate.recallAt).toEqual({ 1: 0, 3: 0 });
  });
});
