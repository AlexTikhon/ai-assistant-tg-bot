/** Raw facts about one document and its chunks, as stored. No judgement: the integrity check decides. */
export type DocumentFacts = {
  userId: string;
  documentId: string;
  fileName: string;
  storedName: string;
  fileSize: number;
  /** null: never recorded (stored before content hashes existed). */
  contentHash: string | null;
  createdAt: string;
  chunkCount: number;
  /** Chunks whose vector cannot be decoded (dimension 0 or a blob of the wrong length). */
  unreadableChunks: number;
  /** Chunks whose owner differs from the owner of their document. */
  foreignChunks: number;
  distinctChunkIndexes: number;
  minChunkIndex: number | null;
  maxChunkIndex: number | null;
  /** How many different dimensions the readable vectors of this document have (1 is healthy). */
  readableDimensions: number;
};

export type FullTextCheck = {
  chunkRows: number;
  indexedRows: number;
  /** Chunks without a full-text entry / full-text entries without a chunk. */
  missing: number;
  extra: number;
};

/**
 * The content-level check of the full-text index (explicit commands only; never at startup):
 *
 * - `index`: SQLite's own comparison of the index with the current chunk text (FTS5 `integrity-check` with the content table
 *   comparison). It detects a chunk whose text changed without its index entry, entries of deleted chunks, and missing entries.
 *   Nothing is stored for it: the index is verified against the chunk text that is already there.
 * - `probe`: a sample of chunks is searched for through the same SQL the bot's keyword search uses, by a distinctive word of the
 *   chunk, as its owner (it must be found) and as another user (it must not).
 */
export type FullTextContentCheck = {
  /** skipped: the comparison needs a private in-memory copy of the database, which is refused for very large databases. */
  index: { status: "ok" | "mismatch" | "skipped"; detail?: string };
  probe: {
    /** Chunks searched for. */
    checked: number;
    /** Not found by their owner although they are in the index. */
    missing: number;
    /** Found for a user who does not own them. */
    leaked: number;
  };
};

/**
 * Cross-user, operator-only view of the stored data for `npm run integrity`. The first methods only read;
 * `rebuildFullText` is the one write and is only called by the explicit repair mode. Never used by the bot's
 * request handling.
 */
export interface IntegrityStore {
  listDocuments(): Promise<DocumentFacts[]>;
  /** The stored file names that documents refer to (one cheap query; for the startup check). */
  listReferencedFiles(): Promise<string[]>;
  /** Chunks whose document row does not exist. */
  countOrphanChunks(): Promise<number>;
  /** Problems found by the database's own structural checks (page corruption, foreign keys); empty when sound. */
  checkDatabase(): Promise<string[]>;
  checkFullText(): Promise<FullTextCheck>;
  /** The deeper, content-level check. Reads only (it works on a private copy); costs time proportional to the database size. */
  checkFullTextContent(options?: { probeLimit?: number }): Promise<FullTextContentCheck>;
  /** Rebuilds the full-text index from the chunk text. Deterministic; the only write of this interface. */
  rebuildFullText(): Promise<void>;
}
