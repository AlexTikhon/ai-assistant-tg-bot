import type { ChunkMatch, StoredChunk } from "../../core/retrieval.js";
import type { ChunkText } from "../../core/document.js";
import type { StoredIndexProfile } from "../../core/index-profile.js";
import type { IndexRevision } from "./document-repository.js";

export type SimilaritySearch = {
  userId: string;
  /** Query vector; only chunks embedded with `embeddingModel` (and the same dimension) are compared against it. */
  embedding: number[];
  embeddingModel: string;
  limit: number;
  /** Minimum cosine similarity. */
  minScore: number;
  /** Narrows the search to a single document of the user. */
  documentId?: string;
};

export type LexicalSearch = {
  userId: string;
  /** Free text (a user question). The store turns it into its own query syntax; it is never executed as one. */
  query: string;
  limit: number;
  documentId?: string;
};

/** The new vector of one chunk, addressed by its position in the document. */
export type EmbeddingUpdate = {
  chunkIndex: number;
  chunkId?: string;
  embedding: number[];
};

/**
 * Chunk search over a user's documents: vector similarity and lexical (full-text) retrieval.
 * The current implementation is SQLite (brute-force cosine + FTS5); other engines could implement
 * the same contract. Searches return light-weight matches; text is fetched with `getChunks` once
 * the final candidates are known. Every method is scoped to a user and never crosses users.
 */
export interface VectorStore {
  /** Best semantic matches first. Never compares vectors of different models or dimensions. */
  searchSimilar(search: SimilaritySearch): Promise<ChunkMatch[]>;
  /** Best keyword matches first (score: higher is better). Independent of the embedding model. */
  searchLexical(search: LexicalSearch): Promise<ChunkMatch[]>;
  /** Text and file name of the given chunks (any order); unknown or foreign ids are simply absent. */
  getChunks(userId: string, chunkIds: string[]): Promise<StoredChunk[]>;
  /** Text of a document's chunks in reading order (no vectors). */
  listByDocument(userId: string, documentId: string): Promise<ChunkText[]>;
  /**
   * Replaces the vectors of *every* chunk of a document (text and ids stay) atomically: either all
   * chunks switch to `model` or none does. Throws if `updates` does not match the stored chunks.
   * When `profile` is given it becomes the document's recorded index profile in the same transaction.
   */
  replaceEmbeddings(
    userId: string,
    documentId: string,
    model: string,
    updates: EmbeddingUpdate[],
    profile?: StoredIndexProfile,
    expectedRevision?: IndexRevision,
  ): Promise<void>;
  /** Removes a document's vectors. Idempotent; a no-op when deleting the document already cascaded. */
  deleteByDocument(userId: string, documentId: string): Promise<void>;
}
