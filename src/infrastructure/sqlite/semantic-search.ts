import type { SimilaritySearch } from "../../application/ports/vector-store.js";
import { TopMatches } from "../../core/top-matches.js";
import { cosineSimilarity, decodeVector, VectorError } from "../../core/vectors.js";

export type VectorRow = { id: string; document_id: string; chunk_index: number; embedding: Uint8Array; embedding_dim: number };
export const VECTOR_COLUMNS = `SELECT id, document_id, chunk_index, embedding, embedding_dim FROM document_chunks
  WHERE user_id = @userId AND embedding_model = @embeddingModel`;

/** Shared scoring path for the file-backed worker and synchronous in-memory fixtures. */
export function scoreVectors(rows: Iterable<VectorRow>, search: SimilaritySearch, checkCancelled: () => void = () => undefined) {
  const top = new TopMatches(search.limit);
  let unusable = 0;
  for (const row of rows) {
    checkCancelled();
    if (row.embedding_dim !== search.embedding.length) { unusable += 1; continue; }
    try {
      const score = cosineSimilarity(search.embedding, decodeVector(row.embedding));
      if (score >= search.minScore) top.add({ chunkId: row.id, documentId: row.document_id, chunkIndex: row.chunk_index, score });
    } catch (error) {
      if (!(error instanceof VectorError)) throw error;
      unusable += 1;
    }
  }
  return { matches: top.sorted(), unusable };
}

export type SemanticResult = ReturnType<typeof scoreVectors>;
