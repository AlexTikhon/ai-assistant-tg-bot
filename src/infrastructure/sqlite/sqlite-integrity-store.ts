import Database from "better-sqlite3";
import type { DocumentFacts, FullTextCheck, FullTextContentCheck, IntegrityStore } from "../../application/ports/integrity-store.js";
import { isContentHash } from "../../core/content-hash.js";
import { LEXICAL_SELECT } from "./sqlite-vector-store.js";

/** The content comparison works on an in-memory copy of the database; above this size it is skipped (and reported as skipped). */
const MAX_CONTENT_CHECK_BYTES = 1024 * 1024 * 1024;
const DEFAULT_PROBE_LIMIT = 200;
/** A distinctive word of a chunk: letters and digits only, so the full-text tokenizer sees exactly the same token. */
const PROBE_WORD = /[\p{L}\p{N}]{4,}/u;

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

  async checkFullTextContent(options: { probeLimit?: number } = {}): Promise<FullTextContentCheck> {
    return { index: this.compareIndexWithContent(), probe: this.probeSearch(options.probeLimit ?? DEFAULT_PROBE_LIMIT) };
  }

  /**
   * FTS5's `integrity-check` with rank = 1 recomputes the index entries of every row of the content table and compares them with the
   * index: the full "does the index describe the text that is stored" question, answered without keeping a second copy of the text.
   * The command is an INSERT, which a read-only connection refuses, so it runs on a private in-memory copy of the database.
   */
  private compareIndexWithContent(): FullTextContentCheck["index"] {
    const bytes = (this.db.pragma("page_count", { simple: true }) as number) * (this.db.pragma("page_size", { simple: true }) as number);
    if (bytes > MAX_CONTENT_CHECK_BYTES) {
      return { status: "skipped", detail: `the database is larger than ${MAX_CONTENT_CHECK_BYTES / 1024 / 1024} MB, which is too large to copy into memory for this check` };
    }

    // The image of a WAL-mode database says "WAL" in its header (bytes 18-19), which an in-memory database cannot honour; the copy
    // already contains everything the WAL held, so it is declared a plain rollback-journal image.
    const image = this.db.serialize();
    image[18] = 1;
    image[19] = 1;
    const copy = new Database(image);
    try {
      copy.prepare("INSERT INTO chunk_fts(chunk_fts, rank) VALUES ('integrity-check', 1)").run();
      return { status: "ok" };
    } catch (error) {
      return { status: "mismatch", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      copy.close();
    }
  }

  /**
   * A sample (evenly spread over the chunks, deterministic) is searched for through the very SQL of the bot's keyword search:
   * the chunk must be found for its owner and must not be found for anybody else.
   */
  private probeSearch(limit: number): FullTextContentCheck["probe"] {
    const total = this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM document_chunks").get()?.n ?? 0;
    const result = { checked: 0, missing: 0, leaked: 0 };
    if (total === 0 || limit <= 0) {
      return result;
    }

    const step = Math.max(1, Math.ceil(total / limit));
    const sample = this.db.prepare<[number, number], { id: string; userId: string; content: string }>(
      "SELECT id, user_id AS userId, content FROM document_chunks WHERE (seq - 1) % ? = 0 ORDER BY seq LIMIT ?",
    );
    const search = this.db.prepare<{ match: string; userId: string; chunkId: string }, { id: string }>(`${LEXICAL_SELECT} AND c.id = @chunkId LIMIT 1`);

    for (const chunk of sample.all(step, limit)) {
      const word = PROBE_WORD.exec(chunk.content)?.[0];
      if (!word) continue; // nothing searchable in it (the tokenizer would not index it either)
      const match = `"${word}"`;

      result.checked += 1;
      if (search.all({ match, userId: chunk.userId, chunkId: chunk.id }).length === 0) result.missing += 1;
      if (search.all({ match, userId: `not-${chunk.userId}`, chunkId: chunk.id }).length > 0) result.leaked += 1;
    }
    return result;
  }

  async rebuildFullText() {
    this.db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES ('rebuild')");
  }
}
