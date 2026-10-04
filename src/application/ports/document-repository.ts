import type { ChunkRecord, DocumentRecord } from "../../core/document.js";
import type { StoredIndexProfile } from "../../core/index-profile.js";

/** Persistence of document metadata. Every lookup is scoped to the owning user. */
export type UserUsage = {
  documentCount: number;
  /** Summed size of the user's original files. */
  totalBytes: number;
};

/** Everything a re-chunk produces; applied to an existing document in one step. */
export type ChunkReplacement = {
  chunks: ChunkRecord[];
  indexProfile: StoredIndexProfile;
  textLength: number;
  /** When the index was rebuilt; recorded as the document's `updatedAt`. */
  updatedAt?: string;
};

/** A prepared new version of an existing document: new file, new content identity, complete new index. */
export type DocumentReplacement = {
  fileName: string;
  storedName: string;
  mimeType: string;
  fileSize: number;
  textLength: number;
  contentHash: string;
  indexProfile: StoredIndexProfile;
  chunks: ChunkRecord[];
  updatedAt: string;
};

export type ReplaceResult = {
  /** The file the document used before; the caller deletes it once the swap is committed. */
  previousStoredName: string;
  documentVersion: number;
};

export interface DocumentRepository {
  /** Stores the document and all of its chunks atomically: either everything is saved or nothing. */
  saveWithChunks(document: DocumentRecord, chunks: ChunkRecord[]): Promise<void>;
  /**
   * Swaps *all* chunks of an existing document for new ones, together with its recorded index profile and
   * text length, atomically: after a failure the previous chunks and profile are untouched. The document
   * row itself (id, owner, file reference, summary) is never changed. Throws when the document does not
   * exist for that user.
   */
  replaceChunks(userId: string, documentId: string, replacement: ChunkReplacement): Promise<void>;
  /**
   * Swaps a document's content for a prepared new version atomically: file reference, size, content hash,
   * recorded profile and *all* chunks change together and the version is incremented; the id, owner and
   * creation time stay. After any failure the previous document and index are untouched. Throws NotFoundError
   * when the document does not exist for that user.
   */
  replaceDocument(userId: string, documentId: string, replacement: DocumentReplacement): Promise<ReplaceResult>;
  /** The user's document with this content (their own documents only; never another user's). */
  findByContentHash(userId: string, contentHash: string): Promise<DocumentRecord | null>;
  /** The user's documents of this size whose content hash is not known yet: candidates for a lazy backfill. */
  findUnhashedBySize(userId: string, fileSize: number): Promise<DocumentRecord[]>;
  /** Records a hash for a document that has none. Never overwrites a known hash; false when nothing changed. */
  setContentHash(userId: string, documentId: string, contentHash: string): Promise<boolean>;
  /**
   * Points the document at another stored file of the *same content* (restoring a lost original). Changes nothing
   * else - not the index, the version, the hash or the timestamps. False when the document does not exist for that user.
   */
  updateStoredName(userId: string, documentId: string, storedName: string): Promise<boolean>;
  /** Number of chunks currently stored for the user's document (0 when it has none or does not exist). */
  countChunks(userId: string, documentId: string): Promise<number>;
  /** How much the user has stored so far (for per-user limits). */
  getUsage(userId: string): Promise<UserUsage>;
  listByUser(userId: string): Promise<DocumentRecord[]>;
  findById(userId: string, documentId: string): Promise<DocumentRecord | null>;
  /**
   * Caches a summary. With `expectedVersion` the summary is only saved when the document is still at that
   * version: a summary computed for content that was replaced in the meantime is dropped, never stored.
   */
  updateSummary(userId: string, documentId: string, summary: string, expectedVersion?: number): Promise<void>;
  /** Deletes the document (and, in SQLite, its chunks via cascade). Returns false if nothing matched. */
  delete(userId: string, documentId: string): Promise<boolean>;
}
