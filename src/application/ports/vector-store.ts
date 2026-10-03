import type { ChunkRecord, ChunkText, RetrievedChunk } from "../../core/document.js";

export type SimilaritySearch = {
  userId: string;
  /** Query vector; only chunks embedded with `embeddingModel` are compared against it. */
  embedding: number[];
  embeddingModel: string;
  topK: number;
  minScore: number;
  /** Narrows the search to a single document of the user. */
  documentId?: string;
};

/**
 * Storage and similarity search for chunk vectors.
 * The current implementation is SQLite; Chroma/pgvector could implement the same contract.
 */
export interface VectorStore {
  /** Inserts chunks, or replaces content/vector of existing ones with the same (documentId, chunkIndex). */
  upsertChunks(chunks: ChunkRecord[]): Promise<void>;
  /** Best matches first. Must never return chunks of other users. */
  searchSimilar(search: SimilaritySearch): Promise<RetrievedChunk[]>;
  /** Text of a document's chunks in reading order (no vectors). */
  listByDocument(userId: string, documentId: string): Promise<ChunkText[]>;
  /** Removes a document's vectors. Idempotent; a no-op when deleting the document already cascaded. */
  deleteByDocument(userId: string, documentId: string): Promise<void>;
}
