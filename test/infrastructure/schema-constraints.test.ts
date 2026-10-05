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

  it("a chunk's owner must be its document's owner: the database refuses a chunk recorded for someone else", () => {
    // Both directions: re-owning an existing chunk, and inserting a chunk for a document of another user.
    expect(() => run("UPDATE document_chunks SET user_id = 'someone-else' WHERE id = 'c1'")).toThrow(/FOREIGN KEY/);
    expect(() =>
      run("INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('x', 'd1', 'u2', 1, 't', x'0000803f', 'm', 1, 'now')"),
    ).toThrow(/FOREIGN KEY/);

    expect(all("SELECT user_id FROM document_chunks")).toEqual([{ user_id: "u1" }]);
  });

  it("a document cannot change owner while it has chunks (the chunks would no longer match it)", () => {
    expect(() => run("UPDATE documents SET user_id = 'u2' WHERE id = 'd1'")).toThrow(/FOREIGN KEY/);
  });

  it("the owner column is kept on chunks because the search filters by it without a join; the constraint is what keeps the copy honest", () => {
    const plan = (all("EXPLAIN QUERY PLAN SELECT id, embedding FROM document_chunks WHERE user_id = 'u1' AND embedding_model = 'm'") as Array<{ detail: string }>).map((row) => row.detail).join(" ");

    expect(plan).toContain("idx_chunks_user_model");
    expect(plan).not.toMatch(/documents/);
  });

  it("the integrity scan still reports a mismatch that got in anyway (a database written with foreign keys off)", () => {
    stores.db.pragma("foreign_keys = OFF");
    run("UPDATE document_chunks SET user_id = 'someone-else' WHERE id = 'c1'");
    stores.db.pragma("foreign_keys = ON");

    expect(all("PRAGMA foreign_key_check")).toEqual([expect.objectContaining({ table: "document_chunks", parent: "documents" })]);
  });
});

describe("chunk range checks", () => {
  it("rejects a negative chunk position and a negative vector dimension", () => {
    expect(() => run("INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('n1', 'd1', 'u1', -1, 't', x'0000803f', 'm', 1, 'now')")).toThrow(/CHECK/);
    expect(() => run("INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('n2', 'd1', 'u1', 7, 't', x'0000803f', 'm', -1, 'now')")).toThrow(/CHECK/);
  });

  it("still accepts dimension 0: that is how an unreadable vector is flagged, and the text stays searchable", () => {
    run("INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('z', 'd1', 'u1', 9, 'zero', x'', 'm', 0, 'now')");

    expect(all("SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'zero'")).toEqual([{ n: 1 }]);
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
