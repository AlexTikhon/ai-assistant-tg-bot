/** The embeddings a healthy index should contain. `dimension` is only known after asking the provider. */
export type EmbeddingTarget = {
  model: string;
  dimension?: number;
};

export type IndexedDocument = {
  userId: string;
  documentId: string;
  fileName: string;
  chunkCount: number;
  /** Chunks whose vector is from another model, unreadable, or of an unexpected dimension. */
  staleChunkCount: number;
};

/**
 * Operator view of the index across all users. Only for maintenance tasks (re-indexing, startup
 * diagnostics) - request handling never uses it, so user isolation of normal queries is unaffected.
 */
export interface IndexMaintenance {
  listIndexedDocuments(target: EmbeddingTarget): Promise<IndexedDocument[]>;
}
