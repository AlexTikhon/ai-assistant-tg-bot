import type Database from "better-sqlite3";
import type { DocumentRepository, UserUsage } from "../../application/ports/document-repository.js";
import type { ChunkRecord, DocumentRecord } from "../../core/document.js";
import { prepareChunkInsert } from "./chunk-rows.js";

type DocumentRow = {
  id: string;
  user_id: string;
  file_name: string;
  stored_name: string;
  mime_type: string | null;
  file_size: number;
  text_length: number;
  summary: string | null;
  created_at: string;
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
  };
}

/** SQLite-backed document metadata. Every statement filters by `user_id`. */
export class SqliteDocumentRepository implements DocumentRepository {
  private readonly insertDocument;
  private readonly insertChunk;
  private readonly selectByUser;
  private readonly selectById;
  private readonly selectUsage;
  private readonly updateSummaryStatement;
  private readonly deleteStatement;
  private readonly saveTransaction;

  constructor(db: Database.Database) {
    this.insertDocument = db.prepare(`
      INSERT INTO documents (id, user_id, file_name, stored_name, mime_type, file_size, text_length, summary, created_at)
      VALUES (@id, @userId, @fileName, @storedName, @mimeType, @fileSize, @textLength, @summary, @createdAt)
    `);
    this.insertChunk = prepareChunkInsert(db);
    this.selectByUser = db.prepare<[string], DocumentRow>(
      "SELECT * FROM documents WHERE user_id = ? ORDER BY created_at DESC, id",
    );
    this.selectById = db.prepare<[string, string], DocumentRow>(
      "SELECT * FROM documents WHERE user_id = ? AND id = ?",
    );
    this.selectUsage = db.prepare<[string], UserUsage>(
      "SELECT COUNT(*) AS documentCount, COALESCE(SUM(file_size), 0) AS totalBytes FROM documents WHERE user_id = ?",
    );
    this.updateSummaryStatement = db.prepare("UPDATE documents SET summary = ? WHERE user_id = ? AND id = ?");
    // Chunks are removed by the ON DELETE CASCADE foreign key (enabled in openDatabase).
    this.deleteStatement = db.prepare("DELETE FROM documents WHERE user_id = ? AND id = ?");

    this.saveTransaction = db.transaction((document: DocumentRecord, chunks: ChunkRecord[]) => {
      this.insertDocument.run(document);
      for (const chunk of chunks) {
        this.insertChunk(chunk);
      }
    });
  }

  async saveWithChunks(document: DocumentRecord, chunks: ChunkRecord[]) {
    this.saveTransaction(document, chunks);
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

  async updateSummary(userId: string, documentId: string, summary: string) {
    this.updateSummaryStatement.run(summary, userId, documentId);
  }

  async delete(userId: string, documentId: string) {
    return this.deleteStatement.run(userId, documentId).changes > 0;
  }
}
