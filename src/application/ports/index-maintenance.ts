import type { StoredIndexProfile } from "../../core/index-profile.js";

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
  /** Chunks whose vector cannot be decoded at all (a subset of the stale ones): corruption, not "another model". */
  unreadableChunkCount: number;
  /** The last page any chunk ends on (PDF only); null when no chunk has page information. Not the page count: trailing pages without text are not known. */
  lastPage?: number | null;
  /** How many chunks carry a Markdown section path. */
  sectionedChunks?: number;
  /**
   * How the document was indexed. The embedding fields always describe the vectors that search really
   * uses (read from the chunks). For documents indexed before recipes were recorded, chunk size and
   * overlap are null (unknown) and the extractor is the legacy one.
   */
  storedProfile: StoredIndexProfile;
};

/**
 * Operator view of the index across all users. Only for maintenance tasks (re-indexing, startup
 * diagnostics) - question answering never uses it, so user isolation of normal queries is unaffected.
 * With `scope.userId` the view is limited to one user's documents (what /list shows that user).
 */
export interface IndexMaintenance {
  listIndexedDocuments(target: EmbeddingTarget, scope?: { userId: string }): Promise<IndexedDocument[]>;
}
