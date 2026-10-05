import type Database from "better-sqlite3";
import type {
  ChunkReplacement,
  DocumentReplacement,
  DocumentRepository,
  DocumentIndexSnapshot,
  ReplaceResult,
  UserUsage,
} from "../../application/ports/document-repository.js";
import { isContentHash } from "../../core/content-hash.js";
import type { ChunkRecord, DocumentRecord } from "../../core/document.js";
import { NotFoundError } from "../../shared/errors.js";
import { prepareChunkInsert } from "./chunk-rows.js";
import { parseProfileColumn, profileColumns } from "./profile-column.js";
import { assertIndexRevision } from "./index-revision.js";
import { assertUserChunkLimit } from "./chunk-limit.js";
import { throwIfCancelled } from "../../shared/operation.js";

type DocumentRow = {
  id: string;
  user_id: string;
  file_name: string;
  stored_name: string;
  mime_type: string | null;
  file_size: number;
  text_length: number;
  summary: string | null;
  index_profile: string | null;
  created_at: string;
  content_hash: string | null;
  document_version: number;
  index_revision: number;
  updated_at: string | null;
  previous_content_hash: string | null;
};

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    userId: row.user_id,
    fileName: row.file_name,
    storedName: row.stored_name,
    mimeType: row.mime_type ?? "application/octet-stream",
    fileSize: row.file_size,
    textLength: row.text_length,
    summary: row.summary,
    createdAt: row.created_at,
    indexProfile: parseProfileColumn(row.index_profile),
    // A malformed stored hash is treated as unknown rather than trusted.
    contentHash: isContentHash(row.content_hash) ? row.content_hash : null,
    documentVersion: row.document_version,
    indexRevision: row.index_revision,
    updatedAt: row.updated_at,
    previousContentHash: isContentHash(row.previous_content_hash) ? row.previous_content_hash : null,
  };
}

/** SQLite-backed document metadata. Every statement filters by `user_id`. */
export class SqliteDocumentRepository implements DocumentRepository {
  private readonly readSnapshot;
  private readonly insertDocument;
  private readonly insertChunk;
  private readonly selectByUser;
  private readonly selectById;
  private readonly selectByHash;
  private readonly selectUnhashed;
  private readonly selectUsage;
  private readonly updateSummaryStatement;
  private readonly updateHash;
  private readonly countChunkRows;
  private readonly countUserChunks: (userId: string) => number;
  private readonly updateStoredNameStatement;
  private readonly deleteStatement;
  private readonly saveTransaction;
  private readonly deleteChunksOfDocument;
  private readonly updateProfile;
  private readonly replaceTransaction;
  private readonly replaceDocumentTransaction;

  constructor(db: Database.Database) {
    const countUserChunks = db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM document_chunks WHERE user_id = ?");
    this.countUserChunks = (userId) => countUserChunks.get(userId)?.count ?? 0;
    const snapshotChunks = db.prepare<[string, string], DocumentIndexSnapshot["chunks"][number]>(
      "SELECT id AS chunkId, chunk_index AS chunkIndex, content FROM document_chunks WHERE user_id = ? AND document_id = ? ORDER BY chunk_index",
    );
    this.readSnapshot = db.transaction((userId: string, documentId: string): DocumentIndexSnapshot | null => {
      const row = this.selectById.get(userId, documentId);
      return row ? {
        document: toDocument(row),
        chunks: snapshotChunks.all(userId, documentId),
        revision: { documentVersion: row.document_version, indexRevision: row.index_revision },
      } : null;
    });
    this.insertDocument = db.prepare(`
      INSERT INTO documents (id, user_id, file_name, stored_name, mime_type, file_size, text_length, summary, index_profile, index_fingerprint, created_at,
                             content_hash, document_version, updated_at, previous_content_hash)
      VALUES (@id, @userId, @fileName, @storedName, @mimeType, @fileSize, @textLength, @summary, @indexProfile, @indexFingerprint, @createdAt,
              @contentHash, @documentVersion, @updatedAt, @previousContentHash)
    `);
    this.insertChunk = prepareChunkInsert(db);
    this.selectByUser = db.prepare<[string], DocumentRow>(
      "SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC, id",
    );
    this.selectById = db.prepare<[string, string], DocumentRow>(
      "SELECT * FROM documents WHERE user_id = ? AND id = ?",
    );
    // Oldest first: when historical duplicates exist, the original is the one reported.
    this.selectByHash = db.prepare<[string, string], DocumentRow>(
      "SELECT * FROM documents WHERE user_id = ? AND content_hash = ? ORDER BY created_at, id LIMIT 1",
    );
    this.selectUnhashed = db.prepare<[string, number], DocumentRow>(
      "SELECT * FROM documents WHERE user_id = ? AND file_size = ? AND content_hash IS NULL ORDER BY created_at, id",
    );
    this.selectUsage = db.prepare<[string], UserUsage>(
      "SELECT COUNT(*) AS documentCount, COALESCE(SUM(file_size), 0) AS totalBytes FROM documents WHERE user_id = ?",
    );
    this.updateSummaryStatement = db.prepare(
      "UPDATE documents SET summary = @summary WHERE user_id = @userId AND id = @documentId AND (@expectedVersion IS NULL OR document_version = @expectedVersion)",
    );
    this.updateHash = db.prepare(
      "UPDATE documents SET content_hash = ? WHERE user_id = ? AND id = ? AND content_hash IS NULL",
    );
    this.updateStoredNameStatement = db.prepare("UPDATE documents SET stored_name = ? WHERE user_id = ? AND id = ?");
    this.countChunkRows = db.prepare<[string, string], { count: number }>(
      "SELECT COUNT(*) AS count FROM document_chunks WHERE user_id = ? AND document_id = ?",
    );
    // Chunks are removed by the ON DELETE CASCADE foreign key (enabled in openDatabase).
    this.deleteStatement = db.prepare("DELETE FROM documents WHERE user_id = ? AND id = ?");

    this.deleteChunksOfDocument = db.prepare("DELETE FROM document_chunks WHERE user_id = ? AND document_id = ?");
    this.updateProfile = db.prepare(
      `UPDATE documents SET text_length = @textLength, index_profile = @indexProfile, index_fingerprint = @indexFingerprint,
              updated_at = COALESCE(@updatedAt, updated_at), index_revision = index_revision + 1
       WHERE user_id = @userId AND id = @documentId`,
    );
    const replaceDocumentRow = db.prepare(
      `UPDATE documents SET file_name = @fileName, stored_name = @storedName, mime_type = @mimeType, file_size = @fileSize,
              text_length = @textLength, summary = NULL, index_profile = @indexProfile, index_fingerprint = @indexFingerprint,
              previous_content_hash = content_hash, content_hash = @contentHash,
              document_version = document_version + 1, index_revision = index_revision + 1, updated_at = @updatedAt
       WHERE user_id = @userId AND id = @documentId`,
    );

    // The FTS triggers fire per row inside this transaction, so the full-text index follows the swap.
    this.replaceTransaction = db.transaction((userId: string, documentId: string, replacement: ChunkReplacement) => {
      assertIndexRevision(db, userId, documentId, replacement.expectedRevision);
      assertUserChunkLimit(db, userId, replacement.chunks.length, replacement.maxChunksPerUser, documentId);
      const updated = this.updateProfile.run({
        userId,
        documentId,
        textLength: replacement.textLength,
        updatedAt: replacement.updatedAt ?? null,
        ...profileColumns(replacement.indexProfile),
      });
      if (updated.changes !== 1) {
        throw new NotFoundError("Document not found.");
      }
      this.deleteChunksOfDocument.run(userId, documentId);
      for (const chunk of replacement.chunks) {
        this.insertChunk(chunk);
      }
    });

    this.replaceDocumentTransaction = db.transaction(
      (userId: string, documentId: string, replacement: DocumentReplacement): ReplaceResult => {
        const previous = this.selectById.get(userId, documentId);
        if (!previous) {
          throw new NotFoundError("Document not found.");
        }
        assertUserChunkLimit(db, userId, replacement.chunks.length, replacement.maxChunksPerUser, documentId);
        replaceDocumentRow.run({ userId, documentId, ...replacement, ...profileColumns(replacement.indexProfile) });
        this.deleteChunksOfDocument.run(userId, documentId);
        for (const chunk of replacement.chunks) {
          this.insertChunk(chunk);
        }
        return { previousStoredName: previous.stored_name, documentVersion: previous.document_version + 1 };
      },
    );

    this.saveTransaction = db.transaction((document: DocumentRecord, chunks: ChunkRecord[], maxChunksPerUser?: number) => {
      assertUserChunkLimit(db, document.userId, chunks.length, maxChunksPerUser);
      this.insertDocument.run({
        ...document,
        ...profileColumns(document.indexProfile),
        contentHash: document.contentHash ?? null,
        documentVersion: document.documentVersion ?? 1,
        updatedAt: document.updatedAt ?? null,
        previousContentHash: document.previousContentHash ?? null,
      });
      for (const chunk of chunks) {
        this.insertChunk(chunk);
      }
    });
  }

  async saveWithChunks(document: DocumentRecord, chunks: ChunkRecord[], maxChunksPerUser?: number) {
    throwIfCancelled();
    this.saveTransaction(document, chunks, maxChunksPerUser);
  }

  async replaceChunks(userId: string, documentId: string, replacement: ChunkReplacement) {
    throwIfCancelled();
    this.replaceTransaction(userId, documentId, replacement);
  }

  async replaceDocument(userId: string, documentId: string, replacement: DocumentReplacement) {
    throwIfCancelled();
    return this.replaceDocumentTransaction(userId, documentId, replacement);
  }

  async findByContentHash(userId: string, contentHash: string) {
    const row = this.selectByHash.get(userId, contentHash);
    return row ? toDocument(row) : null;
  }

  async findUnhashedBySize(userId: string, fileSize: number) {
    return this.selectUnhashed.all(userId, fileSize).map(toDocument);
  }

  async setContentHash(userId: string, documentId: string, contentHash: string) {
    throwIfCancelled();
    return this.updateHash.run(contentHash, userId, documentId).changes > 0;
  }

  async updateStoredName(userId: string, documentId: string, storedName: string) {
    throwIfCancelled();
    return this.updateStoredNameStatement.run(storedName, userId, documentId).changes > 0;
  }

  async countChunks(userId: string, documentId: string) {
    return this.countChunkRows.get(userId, documentId)?.count ?? 0;
  }

  async countChunksForUser(userId: string) {
    return this.countUserChunks(userId);
  }

  async getUsage(userId: string) {
    return this.selectUsage.get(userId) ?? { documentCount: 0, totalBytes: 0 };
  }

  async listByUser(userId: string) {
    return this.selectByUser.all(userId).map(toDocument);
  }

  async findById(userId: string, documentId: string) {
    const row = this.selectById.get(userId, documentId);
    return row ? toDocument(row) : null;
  }

  async readIndexSnapshot(userId: string, documentId: string) {
    return this.readSnapshot(userId, documentId);
  }

  async updateSummary(userId: string, documentId: string, summary: string, expectedVersion?: number) {
    throwIfCancelled();
    this.updateSummaryStatement.run({ summary, userId, documentId, expectedVersion: expectedVersion ?? null });
  }

  async delete(userId: string, documentId: string) {
    throwIfCancelled();
    return this.deleteStatement.run(userId, documentId).changes > 0;
  }
}
