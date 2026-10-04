import type { ChunkRecord, DocumentRecord } from "../../core/document.js";

/** Persistence of document metadata. Every lookup is scoped to the owning user. */
export type UserUsage = {
  documentCount: number;
  /** Summed size of the user's original files. */
  totalBytes: number;
};

export interface DocumentRepository {
  /** Stores the document and all of its chunks atomically: either everything is saved or nothing. */
  saveWithChunks(document: DocumentRecord, chunks: ChunkRecord[]): Promise<void>;
  /** How much the user has stored so far (for per-user limits). */
  getUsage(userId: string): Promise<UserUsage>;
  listByUser(userId: string): Promise<DocumentRecord[]>;
  findById(userId: string, documentId: string): Promise<DocumentRecord | null>;
  updateSummary(userId: string, documentId: string, summary: string): Promise<void>;
  /** Deletes the document (and, in SQLite, its chunks via cascade). Returns false if nothing matched. */
  delete(userId: string, documentId: string): Promise<boolean>;
}
