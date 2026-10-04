import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { LATEST_SCHEMA_VERSION } from "../../src/infrastructure/sqlite/migrations.js";
import { SqliteIndexMaintenance } from "../../src/infrastructure/sqlite/sqlite-index-maintenance.js";
import { SqliteVectorStore } from "../../src/infrastructure/sqlite/sqlite-vector-store.js";

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-migrations-"));
  dbPath = path.join(directory, "app.db");
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

/** The schema created by the first, unversioned release (user_version = 0). */
function createLegacyDatabase() {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, file_name TEXT NOT NULL, stored_name TEXT NOT NULL,
      mime_type TEXT, file_size INTEGER NOT NULL, text_length INTEGER NOT NULL, summary TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE document_chunks (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL, user_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      content TEXT NOT NULL, embedding TEXT NOT NULL, source_label TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(document_id) REFERENCES documents(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_documents_user_id ON documents(user_id);
    CREATE INDEX idx_chunks_user_id ON document_chunks(user_id);
    CREATE INDEX idx_chunks_document_id ON document_chunks(document_id);
  `);
  legacy
    .prepare("INSERT INTO documents VALUES ('d1','u1','a.txt','s-a.txt','text/plain',10,10,'old summary','2025-01-01T00:00:00Z')")
    .run();
  const insertChunk = legacy.prepare("INSERT INTO document_chunks VALUES (?,?,?,?,?,?,?,?)");
  insertChunk.run("c0", "d1", "u1", 0, "first", "[0.1,0.2,0.3]", "a.txt#chunk-1", "2025-01-01T00:00:00Z");
  insertChunk.run("c1", "d1", "u1", 1, "second", "not-json", "a.txt#chunk-2", "2025-01-01T00:00:00Z");
  legacy.close();
}

describe("schema migrations", () => {
  it("creates the latest schema on a fresh database", () => {
    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const columns = db.prepare("PRAGMA table_info(document_chunks)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["embedding_model", "embedding_dim"]),
    );
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });

  it("upgrades an unversioned database in place and keeps existing data", () => {
    createLegacyDatabase();

    const db = openDatabase(dbPath, { legacyEmbeddingModel: "legacy-model" });

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT id, summary FROM documents").all()).toEqual([{ id: "d1", summary: "old summary" }]);

    const chunks = db
      .prepare("SELECT id, content, embedding_model AS model, embedding_dim AS dim FROM document_chunks ORDER BY chunk_index")
      .all();
    expect(chunks).toEqual([
      { id: "c0", content: "first", model: "legacy-model", dim: 3 },
      { id: "c1", content: "second", model: "legacy-model", dim: 0 }, // corrupted vector is flagged, not lost
    ]);

    const columns = (db.prepare("PRAGMA table_info(document_chunks)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).not.toContain("source_label");
    db.close();
  });

  it("enforces unique chunk positions and cascades deletes after upgrading", () => {
    createLegacyDatabase();
    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });

    expect(() =>
      db
        .prepare(
          "INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('x','d1','u1',0,'dup','[1]','m',1,'now')",
        )
        .run(),
    ).toThrow(/UNIQUE/);

    db.prepare("DELETE FROM documents WHERE id = 'd1'").run();
    expect((db.prepare("SELECT COUNT(*) AS n FROM document_chunks").get() as { n: number }).n).toBe(0);
    db.close();
  });

  it("is idempotent when reopened", () => {
    openDatabase(dbPath, { legacyEmbeddingModel: "m" }).close();

    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("refuses to open a database created by a newer version", () => {
    const future = new Database(dbPath);
    future.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    future.close();

    expect(() => openDatabase(dbPath, { legacyEmbeddingModel: "m" })).toThrow(/newer than this application/);
  });

  it("rolls a failed migration back completely", () => {
    createLegacyDatabase();
    // A duplicate (document_id, chunk_index) makes migration 2 fail on the UNIQUE constraint.
    const legacy = new Database(dbPath);
    legacy
      .prepare("INSERT INTO document_chunks VALUES ('dup','d1','u1',0,'dup','[1]','l','2025-01-01T00:00:00Z')")
      .run();
    legacy.close();

    expect(() => openDatabase(dbPath, { legacyEmbeddingModel: "m" })).toThrow(/UNIQUE/);

    const check = new Database(dbPath);
    expect(check.pragma("user_version", { simple: true })).toBe(1); // v1 applied, v2 rolled back
    expect((check.prepare("SELECT COUNT(*) AS n FROM document_chunks").get() as { n: number }).n).toBe(3);
    check.close();
  });
});

/** The schema as released before hybrid search: JSON text vectors, user_version = 2. */
function createVersion2Database() {
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, file_name TEXT NOT NULL, stored_name TEXT NOT NULL,
      mime_type TEXT, file_size INTEGER NOT NULL, text_length INTEGER NOT NULL, summary TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE document_chunks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, content TEXT NOT NULL, embedding TEXT NOT NULL,
      embedding_model TEXT NOT NULL, embedding_dim INTEGER NOT NULL, created_at TEXT NOT NULL,
      UNIQUE (document_id, chunk_index)
    );
    CREATE INDEX idx_chunks_user_model ON document_chunks(user_id, embedding_model);
    CREATE INDEX idx_documents_user_created ON documents(user_id, created_at DESC);
  `);
  old.prepare("INSERT INTO documents VALUES ('d1','u1','a.txt','s-a.txt','text/plain',10,10,NULL,'2025-01-01T00:00:00Z')").run();
  const insert = old.prepare("INSERT INTO document_chunks VALUES (?,?,?,?,?,?,?,?,?)");
  insert.run("c0", "d1", "u1", 0, "ECONNRESET happens upstream", "[1,0,0,0]", "model-a", 4, "2025-01-01T00:00:00Z");
  insert.run("c1", "d1", "u1", 1, "second chunk", "[0,1,0,0]", "model-a", 4, "2025-01-01T00:00:00Z");
  insert.run("c2", "d1", "u1", 2, "broken chunk", "{oops", "model-a", 0, "2025-01-01T00:00:00Z");
  old.pragma("user_version = 2");
  old.close();
}

describe("migrations 3 and 4: binary vectors and FTS5", () => {
  it("creates the FTS5 index and uses a stable integer key for it", () => {
    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });

    expect(db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5").get()).toEqual({ fts5: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'chunk_fts'").get()).toBeTruthy();
    const columns = db.prepare("PRAGMA table_info(document_chunks)").all() as Array<{ name: string; pk: number }>;
    expect(columns.find((column) => column.pk === 1)?.name).toBe("seq");
    db.close();
  });

  it("upgrades a version-2 database: vectors become blobs, nothing is lost, corrupted ones are flagged", () => {
    createVersion2Database();

    const db = openDatabase(dbPath, { legacyEmbeddingModel: "ignored" });

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const rows = db
      .prepare("SELECT id, content, embedding, embedding_model AS model, embedding_dim AS dim FROM document_chunks ORDER BY chunk_index")
      .all() as Array<{ id: string; content: string; embedding: Buffer; model: string; dim: number }>;
    expect(rows.map(({ id, content, model, dim }) => ({ id, content, model, dim }))).toEqual([
      { id: "c0", content: "ECONNRESET happens upstream", model: "model-a", dim: 4 },
      { id: "c1", content: "second chunk", model: "model-a", dim: 4 },
      { id: "c2", content: "broken chunk", model: "model-a", dim: 0 },
    ]);
    expect(Array.from(new Float32Array(rows[0].embedding.buffer.slice(rows[0].embedding.byteOffset, rows[0].embedding.byteOffset + 16)))).toEqual([1, 0, 0, 0]);
    expect(rows[2].embedding.byteLength).toBe(0);
    expect(db.prepare("SELECT summary FROM documents").get()).toEqual({ summary: null });
    db.close();
  });

  it("indexes existing chunks for full-text search during the upgrade", () => {
    createVersion2Database();
    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });

    const hits = db.prepare("SELECT c.id FROM chunk_fts f JOIN document_chunks c ON c.seq = f.rowid WHERE chunk_fts MATCH 'econnreset'").all();

    expect(hits).toEqual([{ id: "c0" }]);
    db.close();
  });

  it("keeps the index in sync with inserts, deletes and cascades after the upgrade", () => {
    createVersion2Database();
    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });
    const hits = (term: string) =>
      db.prepare("SELECT c.id FROM chunk_fts f JOIN document_chunks c ON c.seq = f.rowid WHERE chunk_fts MATCH ?").all(term);

    db.prepare(
      "INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('c3','d1','u1',3,'freshly inserted needle',x'00000000',  'm',1,'now')",
    ).run();
    expect(hits("needle")).toEqual([{ id: "c3" }]);

    db.prepare("DELETE FROM document_chunks WHERE id = 'c3'").run();
    expect(hits("needle")).toEqual([]);

    db.prepare("DELETE FROM documents WHERE id = 'd1'").run();
    expect(hits("econnreset")).toEqual([]);
    expect(db.prepare("INSERT INTO chunk_fts(chunk_fts) VALUES('integrity-check')").run()).toBeTruthy();
    db.close();
  });

  it("upgrades an unversioned (version 0) database all the way and keeps it searchable", () => {
    createLegacyDatabase();
    const db = openDatabase(dbPath, { legacyEmbeddingModel: "legacy-model" });

    const hits = db.prepare("SELECT c.id FROM chunk_fts f JOIN document_chunks c ON c.seq = f.rowid WHERE chunk_fts MATCH 'first'").all();

    expect(hits).toEqual([{ id: "c0" }]);
    db.close();
  });

  it("rolls the whole conversion back when it fails, leaving the version-2 data intact", () => {
    createVersion2Database();
    const old = new Database(dbPath);
    // content NULL is impossible by schema, so provoke a failure through a trigger-free route:
    // a view named like the new table makes CREATE TABLE document_chunks_v3 fail.
    old.exec("CREATE VIEW document_chunks_v3 AS SELECT 1");
    old.close();

    expect(() => openDatabase(dbPath, { legacyEmbeddingModel: "m" })).toThrow();

    const check = new Database(dbPath);
    expect(check.pragma("user_version", { simple: true })).toBe(2);
    expect((check.prepare("SELECT embedding FROM document_chunks WHERE id = 'c0'").get() as { embedding: string }).embedding).toBe("[1,0,0,0]");
    check.close();
  });
});

describe("existing vector-only data after the upgrade", () => {
  it("stays searchable semantically with the model it was embedded with, and by keywords", async () => {
    createVersion2Database();
    const db = openDatabase(dbPath, { legacyEmbeddingModel: "ignored" });
    const store = new SqliteVectorStore(db);

    const semantic = await store.searchSimilar({
      userId: "u1",
      embedding: [1, 0, 0, 0],
      embeddingModel: "model-a",
      limit: 5,
      minScore: 0.2,
    });
    const lexical = await store.searchLexical({ userId: "u1", query: "econnreset", limit: 5 });

    expect(semantic.map((match) => match.chunkId)).toEqual(["c0"]); // c2 is corrupted and skipped, c1 is orthogonal
    expect(lexical.map((match) => match.chunkId)).toEqual(["c0"]);
    expect((await store.getChunks("u1", ["c0"]))[0]).toMatchObject({ fileName: "a.txt", content: "ECONNRESET happens upstream" });
    db.close();
  });

  it("is reported as stale by the maintenance view when the configured model differs, and not otherwise", async () => {
    createVersion2Database();
    const db = openDatabase(dbPath, { legacyEmbeddingModel: "ignored" });
    const maintenance = new SqliteIndexMaintenance(db);

    expect(await maintenance.listIndexedDocuments({ model: "model-a" })).toMatchObject([
      { userId: "u1", documentId: "d1", fileName: "a.txt", chunkCount: 3, staleChunkCount: 1 }, // only the corrupted vector
    ]);
    expect((await maintenance.listIndexedDocuments({ model: "model-b" }))[0].staleChunkCount).toBe(3);
    db.close();
  });
});
