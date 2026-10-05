import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { LATEST_SCHEMA_VERSION, migrations } from "../../src/infrastructure/sqlite/migrations.js";

let directory: string;
let dbPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-m9-"));
  dbPath = path.join(directory, "app.db");
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

/** A database exactly as release schema version 8 leaves it, built by the real migrations 1-8. */
function createVersion8(seed: (db: Database.Database) => void) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  for (const migration of migrations.filter((candidate) => candidate.version <= 8)) {
    db.transaction(() => {
      migration.up(db, { legacyEmbeddingModel: "m" });
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
  seed(db);
  db.close();
}

const document = (db: Database.Database, id: string, user: string) =>
  db.prepare("INSERT INTO documents (id, user_id, file_name, stored_name, file_size, text_length, created_at) VALUES (?, ?, 'a.txt', ?, 1, 1, '2026-01-01')").run(id, user, `s-${id}`);
const chunk = (db: Database.Database, id: string, documentId: string, user: string, index: number, content: string, extra = "") =>
  db
    .prepare(`INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at${extra ? ", page_start, section_path" : ""}) VALUES (?, ?, ?, ?, ?, x'0000803f', 'm', 1, '2026-01-01'${extra ? ", 3, '[\"Intro\"]'" : ""})`)
    .run(id, documentId, user, index, content);

describe("migration 9: chunk owner is enforced by the database", () => {
  it("migrates valid existing data without changing any of it, and keeps search working", () => {
    createVersion8((db) => {
      document(db, "d1", "u1");
      document(db, "d2", "u2");
      chunk(db, "c1", "d1", "u1", 0, "alpha apples", "provenance");
      chunk(db, "c2", "d1", "u1", 1, "beta bananas");
      chunk(db, "c3", "d2", "u2", 0, "gamma grapes");
    });
    const before = new Database(dbPath, { readonly: true });
    const rowsBefore = before.prepare("SELECT * FROM document_chunks ORDER BY seq").all();
    before.close();

    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT * FROM document_chunks ORDER BY seq").all()).toEqual(rowsBefore); // every column, including seq and provenance
    expect(db.prepare("SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH 'bananas'").all()).toHaveLength(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
    // The invariant is in force on the migrated database.
    expect(() => db.prepare("UPDATE document_chunks SET user_id = 'u2' WHERE id = 'c1'").run()).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("keeps the chunk sequence moving forward: a number used by a deleted chunk is not handed out again", () => {
    createVersion8((db) => {
      document(db, "d1", "u1");
      chunk(db, "c1", "d1", "u1", 0, "first");
      chunk(db, "c2", "d1", "u1", 1, "second");
      db.prepare("DELETE FROM document_chunks WHERE id = 'c2'").run(); // seq 2 was used
    });

    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });
    chunk(db, "c3", "d1", "u1", 1, "third");

    expect((db.prepare("SELECT seq FROM document_chunks WHERE id = 'c3'").get() as { seq: number }).seq).toBe(3);
    db.close();
  });

  it("repairs a full-text index that was already out of step, because the index is rebuilt from the copied text", () => {
    createVersion8((db) => {
      document(db, "d1", "u1");
      chunk(db, "c1", "d1", "u1", 0, "indexed text");
      db.exec("DROP TRIGGER chunks_fts_insert");
      chunk(db, "c2", "d1", "u1", 1, "never indexed");
    });

    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });

    expect(db.prepare("SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH 'never'").all()).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunk_fts_docsize").get()).toEqual({ n: 2 });
    db.close();
  });

  it("keeps every trigger, so inserts, edits and deletes keep the full-text index in step after the upgrade", () => {
    createVersion8((db) => {
      document(db, "d1", "u1");
      chunk(db, "c1", "d1", "u1", 0, "alpha");
    });

    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });
    chunk(db, "c2", "d1", "u1", 1, "delta");
    db.prepare("UPDATE document_chunks SET content = 'omega' WHERE id = 'c1'").run();
    const matches = (term: string) => db.prepare("SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ?").all(term).length;

    expect([matches("alpha"), matches("omega"), matches("delta")]).toEqual([0, 1, 1]);
    db.prepare("DELETE FROM documents WHERE id = 'd1'").run(); // cascades
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunk_fts_docsize").get()).toEqual({ n: 0 });
    db.close();
  });

  it("refuses to migrate a database whose chunk owner disagrees with its document, changes nothing, and names the documents", () => {
    createVersion8((db) => {
      document(db, "d1", "u1");
      chunk(db, "c1", "d1", "u1", 0, "fine");
      chunk(db, "c2", "d1", "intruder", 1, "wrong owner");
    });

    expect(() => openDatabase(dbPath, { legacyEmbeddingModel: "m" })).toThrow(/Migration 9 cannot run: 1 chunks are recorded for a different user.*d1/);

    const after = new Database(dbPath, { readonly: true });
    expect(after.pragma("user_version", { simple: true })).toBe(8);
    expect(after.prepare("SELECT user_id FROM document_chunks WHERE id = 'c2'").get()).toEqual({ user_id: "intruder" }); // ownership is never guessed or "fixed"
    after.close();
  });

  it("refuses to migrate a database with chunks of a document that does not exist", () => {
    createVersion8((db) => {
      document(db, "d1", "u1");
      chunk(db, "c1", "d1", "u1", 0, "fine");
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM documents WHERE id = 'd1'").run();
    });

    expect(() => openDatabase(dbPath, { legacyEmbeddingModel: "m" })).toThrow(/chunks belong to a document that does not exist/);
  });

  it("is applied to a fresh database too, and a chunk cannot be inserted for a foreign owner", () => {
    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });
    document(db, "d1", "u1");

    expect(() => chunk(db, "c1", "d1", "u2", 0, "stolen")).toThrow(/FOREIGN KEY/);
    db.close();
  });
});
