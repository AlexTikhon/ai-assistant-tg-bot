import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { LATEST_SCHEMA_VERSION } from "../../src/infrastructure/sqlite/migrations.js";

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
