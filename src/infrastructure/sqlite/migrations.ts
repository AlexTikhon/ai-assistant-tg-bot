import type Database from "better-sqlite3";

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
