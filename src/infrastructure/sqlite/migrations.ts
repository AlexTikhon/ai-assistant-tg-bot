import type Database from "better-sqlite3";
import { encodeVector } from "../../core/vectors.js";

export type MigrationContext = {
  /**
   * Embedding model assumed for chunks that were stored before models were tracked. Pass the model
   * the bot was running with; if it differs from what really produced the vectors, re-index.
   */
  legacyEmbeddingModel: string;
};

type Migration = {
  version: number;
  name: string;
  up(db: Database.Database, context: MigrationContext): void;
};

type ChunkRowV2 = {
  id: string;
  document_id: string;
  user_id: string;
  chunk_index: number;
  content: string;
  embedding: string;
  embedding_model: string;
  embedding_dim: number;
  created_at: string;
};

/** Converts a JSON-array vector (schema v2) to the blob format; anything unreadable becomes an empty blob. */
function jsonToBlob(json: string): { embedding: Buffer; embedding_dim: number } {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return { embedding: encodeVector(parsed), embedding_dim: parsed.length };
    }
  } catch {
    // unreadable: flagged below
  }
  return { embedding: Buffer.alloc(0), embedding_dim: 0 };
}

/**
 * Ordered, append-only list of schema changes. The applied version lives in `PRAGMA user_version`.
 * Never edit a released migration - add a new one.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "baseline schema",
    // The original schema. IF NOT EXISTS makes this a no-op for databases created before versioning.
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          stored_name TEXT NOT NULL,
          mime_type TEXT,
          file_size INTEGER NOT NULL,
          text_length INTEGER NOT NULL,
          summary TEXT,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS document_chunks (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding TEXT NOT NULL,
          source_label TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_user_id ON document_chunks(user_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON document_chunks(document_id);
      `);
    },
  },
  {
    version: 2,
    name: "track embedding model and dimension, enforce chunk uniqueness, query-shaped indexes",
    up(db, context) {
      db.exec(`
        CREATE TABLE document_chunks_v2 (
          id TEXT PRIMARY KEY,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding TEXT NOT NULL,
          embedding_model TEXT NOT NULL,
          embedding_dim INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (document_id, chunk_index)
        );
      `);

      // embedding_dim is 0 for corrupted vectors; searches skip anything whose dimension differs.
      db.prepare(
        `INSERT INTO document_chunks_v2
           (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at)
         SELECT id, document_id, user_id, chunk_index, content, embedding, @model,
                CASE WHEN json_valid(embedding) AND json_type(embedding) = 'array'
                     THEN json_array_length(embedding) ELSE 0 END,
                created_at
         FROM document_chunks`,
      ).run({ model: context.legacyEmbeddingModel });

      db.exec(`
        DROP TABLE document_chunks;
        ALTER TABLE document_chunks_v2 RENAME TO document_chunks;

        -- Search: all chunks of one user for the current embedding model.
        -- (Per-document access is served by the UNIQUE (document_id, chunk_index) index.)
        CREATE INDEX idx_chunks_user_model ON document_chunks(user_id, embedding_model);

        -- /list: a user's documents, newest first. Replaces the user_id-only index.
        DROP INDEX IF EXISTS idx_documents_user_id;
        CREATE INDEX idx_documents_user_created ON documents(user_id, created_at DESC);
      `);
    },
  },
  {
    version: 3,
    name: "store embeddings as float32 blobs, add a stable integer key to chunks",
    up(db) {
      // `seq` is an explicit INTEGER PRIMARY KEY so it survives VACUUM; the full-text index (v4) refers to it.
      db.exec(`
        CREATE TABLE document_chunks_v3 (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          content TEXT NOT NULL,
          embedding BLOB NOT NULL,
          embedding_model TEXT NOT NULL,
          embedding_dim INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (document_id, chunk_index)
        );
      `);

      const insert = db.prepare(
        `INSERT INTO document_chunks_v3
           (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at)
         VALUES (@id, @document_id, @user_id, @chunk_index, @content, @embedding, @embedding_model, @embedding_dim, @created_at)`,
      );
      // Paged (a connection cannot write while a read cursor is open, and vectors in JSON are large).
      const page = db.prepare<[number], ChunkRowV2 & { rowid: number }>(
        "SELECT rowid, * FROM document_chunks WHERE rowid > ? ORDER BY rowid LIMIT 500",
      );
      for (let lastRowId = 0, rows = page.all(lastRowId); rows.length > 0; rows = page.all(lastRowId)) {
        for (const row of rows) {
          // Unreadable vectors keep their row (the text is still searchable) but are flagged with dimension 0.
          insert.run({ ...row, ...jsonToBlob(row.embedding) });
          lastRowId = row.rowid;
        }
      }

      db.exec(`
        DROP TABLE document_chunks;
        ALTER TABLE document_chunks_v3 RENAME TO document_chunks;
        CREATE INDEX idx_chunks_user_model ON document_chunks(user_id, embedding_model);
      `);
    },
  },
  {
    version: 4,
    name: "full-text (FTS5) index over chunk content, kept in sync by triggers",
    up(db) {
      const fts5 = db.prepare<[], { enabled: number }>("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get();
      if (!fts5?.enabled) {
        throw new Error("This SQLite build does not support FTS5, which hybrid search requires.");
      }

      // External-content index: the text stays in document_chunks, FTS5 only stores the token index.
      db.exec(`
        CREATE VIRTUAL TABLE chunk_fts USING fts5(
          content,
          content='document_chunks',
          content_rowid='seq',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER chunks_fts_insert AFTER INSERT ON document_chunks BEGIN
          INSERT INTO chunk_fts(rowid, content) VALUES (new.seq, new.content);
        END;
        CREATE TRIGGER chunks_fts_delete AFTER DELETE ON document_chunks BEGIN
          INSERT INTO chunk_fts(chunk_fts, rowid, content) VALUES ('delete', old.seq, old.content);
        END;
        CREATE TRIGGER chunks_fts_update AFTER UPDATE OF content ON document_chunks BEGIN
          INSERT INTO chunk_fts(chunk_fts, rowid, content) VALUES ('delete', old.seq, old.content);
          INSERT INTO chunk_fts(rowid, content) VALUES (new.seq, new.content);
        END;

        INSERT INTO chunk_fts(chunk_fts) VALUES ('rebuild');
      `);
    },
  },
  {
    version: 5,
    name: "record the index profile per document, page provenance per chunk",
    up(db) {
      // Nullable and unfilled on purpose: rows from earlier versions have no recorded recipe, and
      // inventing one would hide that. Readers describe them from what is actually known.
      db.exec(`
        ALTER TABLE documents ADD COLUMN index_profile TEXT;
        ALTER TABLE documents ADD COLUMN index_fingerprint TEXT;
        ALTER TABLE document_chunks ADD COLUMN page_start INTEGER;
        ALTER TABLE document_chunks ADD COLUMN page_end INTEGER;
      `);
    },
  },
  {
    version: 6,
    name: "optional provenance per chunk: Markdown section path, printed PDF page labels",
    up(db) {
      // All nullable and unfilled for existing rows: a chunk indexed earlier simply has no section or label until
      // its document is re-chunked (the index profile reports that as an extractor change).
      // section_path is a JSON array of heading titles; the labels are the printed page labels at page_start / page_end.
      db.exec(`
        ALTER TABLE document_chunks ADD COLUMN section_path TEXT;
        ALTER TABLE document_chunks ADD COLUMN page_label_start TEXT;
        ALTER TABLE document_chunks ADD COLUMN page_label_end TEXT;
      `);
    },
  },
  {
    version: 7,
    name: "document lifecycle: content hash, version and update metadata",
    up(db) {
      // content_hash stays NULL ("unknown") for existing rows: hashing needs the original file, which may be
      // missing, so it is filled lazily (on a matching upload) or by `npm run integrity -- --repair`.
      // The index is deliberately NOT unique: historical duplicates are legitimate data, and a uniqueness
      // rule would make the backfill and this migration fail on them. The one-document-per-content rule
      // is enforced by the ingestion use case (serialized per user) and reported by the integrity check.
      db.exec(`
        ALTER TABLE documents ADD COLUMN content_hash TEXT;
        ALTER TABLE documents ADD COLUMN document_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE documents ADD COLUMN updated_at TEXT;
        ALTER TABLE documents ADD COLUMN previous_content_hash TEXT;
        CREATE INDEX idx_documents_user_hash ON documents(user_id, content_hash);
      `);
    },
  },
  {
    version: 8,
    name: "answer feedback (thumbs up/down) correlated with the confidence decision",
    up(db) {
      // Deliberately tiny and free of text: who rated which answer (by its short request id), how, and what the
      // confidence gate had decided. IF NOT EXISTS keeps the migration re-runnable.
      db.exec(`
        CREATE TABLE IF NOT EXISTS answer_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          rating TEXT NOT NULL CHECK (rating IN ('good', 'bad')),
          created_at TEXT NOT NULL,
          confidence_mode TEXT,
          decision TEXT,
          reason TEXT,
          shadow_decision TEXT,
          shadow_reason TEXT,
          top_semantic_score REAL,
          UNIQUE (request_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_created ON answer_feedback(created_at);
      `);
    },
  },
];

export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1].version;

/** Applies pending migrations, each in its own transaction together with the version bump. */
export function runMigrations(db: Database.Database, context: MigrationContext) {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;

  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is newer than this application supports (${LATEST_SCHEMA_VERSION}).`,
    );
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) {
      continue;
    }

    db.transaction(() => {
      migration.up(db, context);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
