import { beforeEach, describe, expect, it } from "vitest";
import { createTestStores, makeChunk, makeDocument } from "../support/fakes.js";

/**
 * The constraints the lifecycle relies on, checked against the real schema after all migrations. Where a rule is
 * deliberately NOT a constraint, the test says so and why - those are the decisions behind the schema.
 */
let stores: ReturnType<typeof createTestStores>;
const run = (sql: string, ...params: unknown[]) => stores.db.prepare(sql).run(...params);
const all = (sql: string, ...params: unknown[]) => stores.db.prepare(sql).all(...params);

beforeEach(async () => {
  stores = createTestStores();
  await stores.documents.saveWithChunks(makeDocument({ id: "d1", userId: "u1" }), [makeChunk({ id: "c1", documentId: "d1", userId: "u1", chunkIndex: 0, content: "alpha beta" })]);
});

describe("document ownership and references", () => {
  it("foreign keys are enforced: a chunk cannot refer to a document that does not exist", () => {
    expect(stores.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => run("INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('x', 'ghost', 'u1', 0, 't', x'0000803f', 'm', 1, 'now')")).toThrow(/FOREIGN KEY/);
  });

  it("deleting a document removes its chunks and their full-text entries", () => {
    run("DELETE FROM documents WHERE id = 'd1'");

    expect(all("SELECT id FROM document_chunks")).toEqual([]);
    expect(all("SELECT id FROM chunk_fts_docsize")).toEqual([]);
  });

  it("every document has an owner and a stored file name", () => {
    expect(() => run("INSERT INTO documents (id, user_id, file_name, stored_name, file_size, text_length, created_at) VALUES ('n', NULL, 'a', 'b', 1, 1, 'now')")).toThrow(/NOT NULL/);
    expect(() => run("INSERT INTO documents (id, user_id, file_name, stored_name, file_size, text_length, created_at) VALUES ('n', 'u', 'a', NULL, 1, 1, 'now')")).toThrow(/NOT NULL/);
  });

  it("a chunk's owner is NOT a database constraint (it would need a composite key and a table rebuild); code derives it from the document and `npm run integrity` reports a mismatch", () => {
    run("UPDATE document_chunks SET user_id = 'someone-else' WHERE id = 'c1'");

    expect(all("SELECT user_id FROM document_chunks")).toEqual([{ user_id: "someone-else" }]);
  });
});

describe("chunk uniqueness", () => {
  it("a chunk position exists once per document", () => {
    expect(() => run("INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('c2', 'd1', 'u1', 0, 't', x'0000803f', 'm', 1, 'now')")).toThrow(/UNIQUE/);
  });

  it("chunk ids are unique", () => {
    expect(() => run("INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('c1', 'd1', 'u1', 5, 't', x'0000803f', 'm', 1, 'now')")).toThrow(/UNIQUE/);
  });
});

describe("content identity", () => {
  it("is indexed for the duplicate lookup, but deliberately not unique: historical duplicates are legitimate data and a unique index would break the backfill", () => {
    const index = (all("PRAGMA index_list(documents)") as Array<{ name: string; unique: number }>).find((entry) => entry.name === "idx_documents_user_hash");

    expect(index).toBeDefined();
    expect(index?.unique).toBe(0);
    expect((all("PRAGMA index_info(idx_documents_user_hash)") as Array<{ name: string }>).map((column) => column.name)).toEqual(["user_id", "content_hash"]);
  });

  it("new documents start at version 1; the hash is NULL (unknown) until recorded", () => {
    expect(all("SELECT content_hash, document_version FROM documents")).toEqual([{ content_hash: null, document_version: 1 }]);
  });
});

describe("full-text index synchronisation", () => {
  const matches = (term: string) => all("SELECT rowid FROM chunk_fts WHERE chunk_fts MATCH ?", term).length;

  it("follows inserts, updates and deletes of chunks through triggers", () => {
    expect(matches("alpha")).toBe(1);

    run("UPDATE document_chunks SET content = 'gamma delta' WHERE id = 'c1'");
    expect(matches("alpha")).toBe(0);
    expect(matches("gamma")).toBe(1);

    run("DELETE FROM document_chunks WHERE id = 'c1'");
    expect(matches("gamma")).toBe(0);
  });
});

describe("feedback table", () => {
  it("accepts only good or bad and one row per user and answer", () => {
    run("INSERT INTO answer_feedback (request_id, user_id, rating, created_at) VALUES ('abcd1234', 'u1', 'good', 'now')");

    expect(() => run("INSERT INTO answer_feedback (request_id, user_id, rating, created_at) VALUES ('abcd1234', 'u1', 'bad', 'now')")).toThrow(/UNIQUE/);
    expect(() => run("INSERT INTO answer_feedback (request_id, user_id, rating, created_at) VALUES ('eeee1111', 'u1', 'meh', 'now')")).toThrow(/CHECK/);
  });
});
