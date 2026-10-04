import type Database from "better-sqlite3";
import type { DocumentFacts, FullTextCheck, IntegrityStore } from "../../application/ports/integrity-store.js";
import { isContentHash } from "../../core/content-hash.js";

const READABLE = "(c.embedding_dim > 0 AND length(c.embedding) = c.embedding_dim * 4)";

type FactsRow = Omit<DocumentFacts, "contentHash"> & { contentHash: string | null };

/**
 * Structural and consistency facts straight from SQLite. Everything except `rebuildFullText` is a plain
 * SELECT/PRAGMA read, so the store works on a database that was opened read-only - and a write attempted on
 * such a connection fails inside SQLite, which is the second line of defence behind the read-only mode.
 */
export class SqliteIntegrityStore implements IntegrityStore {
  private readonly selectDocuments;
  private readonly selectReferencedFiles;
  private readonly selectOrphanChunks;
  private readonly selectFullText;

  constructor(private readonly db: Database.Database) {
    this.selectDocuments = db.prepare<[], FactsRow>(
      `SELECT d.user_id AS userId, d.id AS documentId, d.file_name AS fileName, d.stored_name AS storedName,
              d.file_size AS fileSize, d.content_hash AS contentHash, d.created_at AS createdAt,
              COUNT(c.seq) AS chunkCount,
              COALESCE(SUM(CASE WHEN c.seq IS NOT NULL AND NOT ${READABLE} THEN 1 ELSE 0 END), 0) AS unreadableChunks,
              COALESCE(SUM(CASE WHEN c.user_id != d.user_id THEN 1 ELSE 0 END), 0) AS foreignChunks,
              COUNT(DISTINCT c.chunk_index) AS distinctChunkIndexes,
              MIN(c.chunk_index) AS minChunkIndex, MAX(c.chunk_index) AS maxChunkIndex,
              COUNT(DISTINCT CASE WHEN ${READABLE} THEN c.embedding_dim END) AS readableDimensions
       FROM documents d LEFT JOIN document_chunks c ON c.document_id = d.id
       GROUP BY d.id
       ORDER BY d.created_at, d.id`,
    );
    this.selectReferencedFiles = db.prepare<[], { storedName: string }>("SELECT stored_name AS storedName FROM documents");
    this.selectOrphanChunks = db.prepare<[], { count: number }>(
      "SELECT COUNT(*) AS count FROM document_chunks c WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = c.document_id)",
    );
    // chunk_fts_docsize is the shadow table of the external-content FTS5 index: one row per indexed chunk (rowid = seq).
    this.selectFullText = db.prepare<[], FullTextCheck>(
      `SELECT (SELECT COUNT(*) FROM document_chunks) AS chunkRows,
              (SELECT COUNT(*) FROM chunk_fts_docsize) AS indexedRows,
              (SELECT COUNT(*) FROM document_chunks WHERE seq NOT IN (SELECT id FROM chunk_fts_docsize)) AS missing,
              (SELECT COUNT(*) FROM chunk_fts_docsize WHERE id NOT IN (SELECT seq FROM document_chunks)) AS extra`,
    );
  }

  async listDocuments() {
    return this.selectDocuments.all().map((row) => ({ ...row, contentHash: isContentHash(row.contentHash) ? row.contentHash : null }));
  }

  async listReferencedFiles() {
    return this.selectReferencedFiles.all().map((row) => row.storedName);
  }

  async countOrphanChunks() {
    return this.selectOrphanChunks.get()?.count ?? 0;
  }

  async checkDatabase() {
    const problems: string[] = [];

    for (const row of this.db.pragma("quick_check") as Array<{ quick_check: string }>) {
      if (row.quick_check !== "ok") {
        problems.push(row.quick_check);
      }
    }
    for (const row of this.db.pragma("foreign_key_check") as Array<{ table: string; rowid: number; parent: string }>) {
      problems.push(`foreign key violation: row ${row.rowid} of ${row.table} refers to a missing row of ${row.parent}`);
    }

    return problems;
  }

  async checkFullText() {
    return this.selectFullText.get() ?? { chunkRows: 0, indexedRows: 0, missing: 0, extra: 0 };
  }

  async rebuildFullText() {
    this.db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES ('rebuild')");
  }
}
