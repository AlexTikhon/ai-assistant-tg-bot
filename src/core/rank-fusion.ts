import type { ChunkMatch, RetrievalRanking, RetrievedChunk } from "./retrieval.js";
import { matchesExactTarget } from "./technical-tokens.js";

export type FusedMatch = RetrievalRanking & {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
};

/** The constant from the original RRF paper; larger values flatten the advantage of top ranks. */
export const DEFAULT_RRF_K = 60;

/** How much each ranking contributes. 1 / 1 is plain RRF. */
export type FusionWeights = { semantic: number; lexical: number };

const EQUAL_WEIGHTS: FusionWeights = { semantic: 1, lexical: 1 };

/**
 * Reciprocal Rank Fusion: score(chunk) = sum over rankings of weight / (k + rank). Plain RRF (the default)
 * has weight 1 for both rankings.
 *
 * Cosine similarity and BM25 live on unrelated scales, so only the *position* in each list is used.
 * A chunk found by both methods outranks one found by a single method; a chunk found by just one
 * still participates. Input lists must be ordered best first. Pure and deterministic.
 */
export function reciprocalRankFusion(
  semantic: readonly ChunkMatch[],
  lexical: readonly ChunkMatch[],
  k = DEFAULT_RRF_K,
  weights: FusionWeights = EQUAL_WEIGHTS,
): FusedMatch[] {
  if (!(k > 0)) {
    throw new RangeError("k must be positive");
  }
  if (![weights.semantic, weights.lexical].every((weight) => Number.isFinite(weight) && weight >= 0) || weights.semantic + weights.lexical === 0) {
    throw new RangeError("fusion weights must be finite, not negative, and not both zero");
  }

  const merged = new Map<string, Omit<FusedMatch, "fusedRank">>();
  const add = (matches: readonly ChunkMatch[], source: "semantic" | "lexical") => {
    matches.forEach((match, index) => {
      const rank = index + 1;
      const entry = merged.get(match.chunkId) ?? {
        chunkId: match.chunkId,
        documentId: match.documentId,
        chunkIndex: match.chunkIndex,
        fusedScore: 0,
      };
      const alreadyRanked = source === "semantic" ? entry.semanticRank : entry.lexicalRank;
      if (alreadyRanked === undefined) {
        entry.fusedScore += weights[source] / (k + rank);
        if (source === "semantic") {
          entry.semanticRank = rank;
          entry.semanticScore = match.score;
        } else {
          entry.lexicalRank = rank;
          entry.lexicalScore = match.score;
        }
      }
      merged.set(match.chunkId, entry);
    });
  };
  add(semantic, "semantic");
  add(lexical, "lexical");

  const bestRank = (entry: Omit<FusedMatch, "fusedRank">) =>
    Math.min(entry.semanticRank ?? Infinity, entry.lexicalRank ?? Infinity);

  return [...merged.values()]
    .sort(
      (a, b) =>
        b.fusedScore - a.fusedScore ||
        bestRank(a) - bestRank(b) ||
        a.documentId.localeCompare(b.documentId) ||
        a.chunkIndex - b.chunkIndex,
    )
    .map((entry, index) => ({ ...entry, fusedRank: index + 1 }));
}

/**
 * Adds `bonus` (an absolute fused-score amount) once to every candidate that contains at least one of the
 * question's exact targets (identifier, file name, version, quoted phrase) as a whole token, then re-ranks.
 * Equal scores keep their previous order. Records how many targets matched in `ranking.exactMatches`.
 * A bonus of 0 or no targets returns the candidates unchanged. Pure; the input is not modified.
 */
export function boostExactMatches(candidates: readonly RetrievedChunk[], targets: readonly string[], bonus: number): RetrievedChunk[] {
  if (!Number.isFinite(bonus) || bonus < 0) {
    throw new RangeError("bonus must be a finite number >= 0");
  }
  if (bonus === 0 || targets.length === 0) {
    return [...candidates];
  }

  return candidates
    .map((chunk, position) => {
      const matches = targets.filter((target) => matchesExactTarget(chunk, target)).length;
      const ranking = matches === 0 ? chunk.ranking : { ...chunk.ranking, fusedScore: chunk.ranking.fusedScore + bonus, exactMatches: matches };
      return { chunk: { ...chunk, ranking }, position };
    })
    .sort((a, b) => b.chunk.ranking.fusedScore - a.chunk.ranking.fusedScore || a.position - b.position)
    .map(({ chunk }, index) => ({ ...chunk, ranking: { ...chunk.ranking, fusedRank: index + 1 } }));
}
