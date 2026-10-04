import type Database from "better-sqlite3";
import type { EmbeddingTarget, IndexedDocument, IndexMaintenance } from "../../application/ports/index-maintenance.js";

/** A vector is stale when it came from another model, is unreadable, or has an unexpected dimension. */
const STALE_CHUNK = `(c.embedding_model != @model
  OR c.embedding_dim <= 0
  OR length(c.embedding) != c.embedding_dim * 4
  OR (@dimension IS NOT NULL AND c.embedding_dim != @dimension))`;

/** Cross-user statistics about the index, for re-indexing and startup diagnostics. */
export class SqliteIndexMaintenance implements IndexMaintenance {
  private readonly selectDocuments;

  constructor(db: Database.Database) {
    this.selectDocuments = db.prepare<{ model: string; dimension: number | null }, IndexedDocument>(
      `SELECT d.user_id AS userId, d.id AS documentId, d.file_name AS fileName,
              COUNT(c.seq) AS chunkCount,
              COALESCE(SUM(CASE WHEN ${STALE_CHUNK} THEN 1 ELSE 0 END), 0) AS staleChunkCount
       FROM documents d
       LEFT JOIN document_chunks c ON c.document_id = d.id AND c.user_id = d.user_id
       GROUP BY d.id
       ORDER BY d.created_at, d.id`,
    );
  }

  async listIndexedDocuments(target: EmbeddingTarget): Promise<IndexedDocument[]> {
    return this.selectDocuments.all({ model: target.model, dimension: target.dimension ?? null });
  }
}
