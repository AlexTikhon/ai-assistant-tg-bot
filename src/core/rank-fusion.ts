import type { ChunkMatch, RetrievalRanking } from "./retrieval.js";

export type FusedMatch = RetrievalRanking & {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
};

/** The constant from the original RRF paper; larger values flatten the advantage of top ranks. */
export const DEFAULT_RRF_K = 60;

/**
 * Reciprocal Rank Fusion: score(chunk) = sum over rankings of 1 / (k + rank).
 *
 * Cosine similarity and BM25 live on unrelated scales, so only the *position* in each list is used.
 * A chunk found by both methods outranks one found by a single method; a chunk found by just one
 * still participates. Input lists must be ordered best first. Pure and deterministic.
 */
export function reciprocalRankFusion(
  semantic: readonly ChunkMatch[],
  lexical: readonly ChunkMatch[],
  k = DEFAULT_RRF_K,
): FusedMatch[] {
  if (!(k > 0)) {
    throw new RangeError("k must be positive");
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
        entry.fusedScore += 1 / (k + rank);
        if (source === "semantic") {
          entry.semanticRank = rank;
          entry.semanticScore = match.score;
        } else {
          entry.lexicalRank = rank;
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
