/**
 * Retrieval metrics. Pure functions over *match ranks*: for every source a question expects, the 1-based
 * position of the first retrieved chunk that satisfies it, or null if none did. Binary relevance only -
 * a chunk either supports an expected source or not - so nDCG would add nothing here.
 */
export type MatchRanks = ReadonlyArray<number | null>;

function assertK(k: number) {
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError("k must be an integer >= 1");
  }
}

const within = (rank: number | null, k: number) => rank !== null && rank <= k;

/** Share of the expected sources found in the first `k` results; undefined when nothing was expected. */
export function recallAtK(ranks: MatchRanks, k: number): number | undefined {
  assertK(k);
  return ranks.length === 0 ? undefined : ranks.filter((rank) => within(rank, k)).length / ranks.length;
}

/** 1 if at least one expected source is in the first `k` results, else 0; undefined when nothing was expected. */
export function hitAtK(ranks: MatchRanks, k: number): number | undefined {
  assertK(k);
  return ranks.length === 0 ? undefined : ranks.some((rank) => within(rank, k)) ? 1 : 0;
}

/** 1 / rank of the first relevant result; 0 when none was retrieved; undefined when nothing was expected. */
export function reciprocalRank(ranks: MatchRanks): number | undefined {
  if (ranks.length === 0) {
    return undefined;
  }
  const best = Math.min(...ranks.map((rank) => rank ?? Number.POSITIVE_INFINITY));
  return Number.isFinite(best) ? 1 / best : 0;
}

/** Mean of the defined values; 0 for none (so reports never contain NaN). */
export function mean(values: ReadonlyArray<number | undefined>): number {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length === 0 ? 0 : defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

/** What the aggregate needs from one evaluated question. */
export type CaseMetrics = {
  /** Match ranks within the context the model would see. */
  ranks: MatchRanks;
  /** Match ranks within the fused candidate list, before de-duplication, caps and budget. */
  candidateRanks: MatchRanks;
};

export type AggregateMetrics = {
  /** Answerable questions the numbers are based on. */
  cases: number;
  recallAt: Record<number, number>;
  hitRateAt: Record<number, number>;
  mrr: number;
  /** The same, measured before context selection: the gap shows what de-duplication/caps/budget cost. */
  candidateRecallAt: Record<number, number>;
  candidateMrr: number;
  /** Cases where an expected source was a candidate but did not reach the context. */
  lostToSelection: number;
};

/** Averages over the answerable cases (those that expect at least one source); other cases are ignored. */
export function aggregateCases(cases: readonly CaseMetrics[], ks: readonly number[]): AggregateMetrics {
  const answerable = cases.filter((item) => item.ranks.length > 0);
  const byK = (score: (item: CaseMetrics, k: number) => number | undefined) =>
    Object.fromEntries(ks.map((k) => [k, mean(answerable.map((item) => score(item, k)))]));

  return {
    cases: answerable.length,
    recallAt: byK((item, k) => recallAtK(item.ranks, k)),
    hitRateAt: byK((item, k) => hitAtK(item.ranks, k)),
    mrr: mean(answerable.map((item) => reciprocalRank(item.ranks))),
    candidateRecallAt: byK((item, k) => recallAtK(item.candidateRanks, k)),
    candidateMrr: mean(answerable.map((item) => reciprocalRank(item.candidateRanks))),
    lostToSelection: answerable.filter((item) =>
      item.candidateRanks.some((rank, index) => rank !== null && item.ranks[index] === null),
    ).length,
  };
}
