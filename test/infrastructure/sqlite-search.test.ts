import { beforeEach, describe, expect, it } from "vitest";
import { encodeVector } from "../../src/core/vectors.js";
import { LEXICAL_SELECT } from "../../src/infrastructure/sqlite/sqlite-vector-store.js";
import { createTestStores, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;

beforeEach(() => {
  stores = createTestStores();
});

function count(table: string) {
  return (stores.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

type SeedChunk = { content: string; embedding?: number[]; embeddingModel?: string };

async function seed(userId: string, documentId: string, chunks: Array<string | SeedChunk>, fileName = `${documentId}.txt`) {
  await stores.documents.saveWithChunks(
    makeDocument({ id: documentId, userId, fileName }),
    chunks.map((entry, chunkIndex) => {
      const chunk = typeof entry === "string" ? { content: entry } : entry;
      return makeChunk({ id: `${documentId}-${chunkIndex}`, documentId, userId, chunkIndex, ...chunk });
    }),
  );
}

const semantic = (overrides: Partial<Parameters<typeof stores.vectorStore.searchSimilar>[0]> = {}) =>
  stores.vectorStore.searchSimilar({
    userId: "user-1",
    embedding: [1, 0, 0, 0],
    embeddingModel: "test-model",
    limit: 5,
    minScore: 0.2,
    ...overrides,
  });

const lexical = (query: string, overrides: Partial<Parameters<typeof stores.vectorStore.searchLexical>[0]> = {}) =>
  stores.vectorStore.searchLexical({ userId: "user-1", query, limit: 5, ...overrides });

const ids = (matches: Array<{ chunkId: string }>) => matches.map((match) => match.chunkId);

describe("SqliteVectorStore.searchSimilar", () => {
  it("ranks by similarity, applies the limit and returns light-weight matches (no text)", async () => {
    await seed("user-1", "doc-1", [
      { content: "a", embedding: [1, 0, 0, 0] },
      { content: "b", embedding: [1, 1, 0, 0] },
      { content: "c", embedding: [0, 0, 1, 0] },
    ]);

    const results = await semantic({ limit: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ chunkId: "doc-1-0", documentId: "doc-1", chunkIndex: 0 });
    expect(results[0].score).toBeCloseTo(1);
    expect(results[1]).toMatchObject({ chunkId: "doc-1-1", chunkIndex: 1 });
    expect(results[1].score).toBeCloseTo(Math.SQRT1_2);
    expect(results[0]).not.toHaveProperty("content");
  });

  it("filters out chunks below minScore", async () => {
    await seed("user-1", "doc-1", [{ content: "a", embedding: [0, 1, 0, 0] }]);

    expect(await semantic()).toEqual([]);
  });

  it("never returns another user's chunks, even if they match perfectly", async () => {
    await seed("user-1", "doc-1", [{ content: "a", embedding: [0, 1, 0, 0] }]);
    await seed("user-2", "doc-2", [{ content: "a", embedding: [1, 0, 0, 0] }]);

    expect(await semantic({ userId: "user-1" })).toEqual([]);
    expect((await semantic({ userId: "user-2" })).map((result) => result.documentId)).toEqual(["doc-2"]);
  });

  it("does not leak across users even when a documentId of another user is requested", async () => {
    await seed("user-2", "doc-2", [{ content: "a", embedding: [1, 0, 0, 0] }]);

    expect(await semantic({ userId: "user-1", documentId: "doc-2" })).toEqual([]);
  });

  it("can be scoped to one document", async () => {
    await seed("user-1", "doc-1", [{ content: "a", embedding: [1, 0, 0, 0] }]);
    await seed("user-1", "doc-2", [{ content: "a", embedding: [1, 0, 0, 0] }]);

    expect((await semantic({ documentId: "doc-2" })).map((result) => result.documentId)).toEqual(["doc-2"]);
  });

  it("ignores chunks that were embedded with a different model", async () => {
    await seed("user-1", "doc-1", [{ content: "a", embedding: [1, 0, 0, 0] }]);

    expect(await semantic({ embeddingModel: "another-model" })).toEqual([]);
  });

  it("skips chunks whose dimension differs from the query instead of failing or mis-scoring", async () => {
    await seed("user-1", "doc-1", [
      { content: "ok", embedding: [1, 0, 0, 0] },
      { content: "wrong size", embedding: [1, 0, 0, 0, 0, 0] },
    ]);

    expect((await semantic()).map((result) => result.chunkIndex)).toEqual([0]);
  });

  it("skips corrupted blobs (empty, misaligned, non-finite)", async () => {
    await seed("user-1", "doc-1", ["a", "b", "c", "d"].map((content) => ({ content, embedding: [1, 0, 0, 0] })));
    const corrupt = (index: number, blob: Buffer) =>
      stores.db.prepare("UPDATE document_chunks SET embedding = ? WHERE chunk_index = ?").run(blob, index);
    corrupt(1, Buffer.alloc(0));
    corrupt(2, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]));
    corrupt(3, Buffer.from(new Float32Array([1, Number.NaN, 0, 0]).buffer));

    expect((await semantic()).map((result) => result.chunkIndex)).toEqual([0]);
  });

  it("skips legacy JSON text vectors rather than failing", async () => {
    await seed("user-1", "doc-1", ["a", "b"].map((content) => ({ content, embedding: [1, 0, 0, 0] })));
    stores.db.prepare("UPDATE document_chunks SET embedding = ? WHERE chunk_index = 1").run("[1,0,0,0]");

    expect((await semantic()).map((result) => result.chunkIndex)).toEqual([0]);
  });
});

describe("SqliteVectorStore.searchLexical (FTS5)", () => {
  it("finds exact technical terms, identifiers and error strings", async () => {
    await seed("user-1", "doc-1", [
      "The service retries when it sees ECONNRESET from the upstream proxy.",
      "Configuration lives in api_client.ts and is loaded at startup.",
      "Nothing about networking in this paragraph, only gardening tips.",
    ]);

    expect(ids(await lexical("ECONNRESET"))).toEqual(["doc-1-0"]);
    expect(ids(await lexical("where is api_client.ts?"))).toEqual(["doc-1-1"]);
  });

  it("ranks chunks with more of the rare query terms first and returns positive scores", async () => {
    await seed("user-1", "doc-1", [
      "alpha common text",
      "alpha beta common text",
      "alpha beta gamma common text",
    ]);

    const results = await lexical("alpha beta gamma");

    expect(ids(results)).toEqual(["doc-1-2", "doc-1-1", "doc-1-0"]);
    expect(results.every((result) => result.score > 0)).toBe(true);
    expect(results[0].score).toBeGreaterThan(results[2].score);
  });

  it("is user-isolated", async () => {
    await seed("user-1", "doc-1", ["secret ECONNRESET note"]);
    await seed("user-2", "doc-2", ["ECONNRESET in another account"]);

    expect(ids(await lexical("ECONNRESET", { userId: "user-1" }))).toEqual(["doc-1-0"]);
    expect(ids(await lexical("ECONNRESET", { userId: "user-2" }))).toEqual(["doc-2-0"]);
    expect(await lexical("ECONNRESET", { userId: "user-3" })).toEqual([]);
    expect(await lexical("ECONNRESET", { userId: "user-1", documentId: "doc-2" })).toEqual([]);
  });

  it("can be scoped to one document and limited", async () => {
    await seed("user-1", "doc-1", ["needle one", "needle two"]);
    await seed("user-1", "doc-2", ["needle three"]);

    expect(ids(await lexical("needle", { documentId: "doc-2" }))).toEqual(["doc-2-0"]);
    expect(await lexical("needle", { limit: 2 })).toHaveLength(2);
  });

  it("drops deleted documents from the index (cascade delete and deleteByDocument)", async () => {
    await seed("user-1", "doc-1", ["needle in the first document"]);
    await seed("user-1", "doc-2", ["needle in the second document"]);

    await stores.documents.delete("user-1", "doc-1");
    expect(ids(await lexical("needle"))).toEqual(["doc-2-0"]);

    await stores.vectorStore.deleteByDocument("user-1", "doc-2");
    expect(await lexical("needle")).toEqual([]);
    expect((stores.db.prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'needle'").get() as { n: number }).n).toBe(0);
  });

  it("indexes chunks whose embeddings are stale (lexical search does not depend on the model)", async () => {
    await seed("user-1", "doc-1", [{ content: "legacy ECONNRESET text", embeddingModel: "old-model" }]);

    expect(await semantic()).toEqual([]);
    expect(ids(await lexical("ECONNRESET"))).toEqual(["doc-1-0"]);
  });

  it("treats FTS operators in the query as plain text and ignores empty queries", async () => {
    await seed("user-1", "doc-1", ["plain words here"]);

    await expect(lexical('"unbalanced AND OR NOT ( * :')).resolves.toEqual([]);
    await expect(lexical("")).resolves.toEqual([]);
    await expect(lexical("the and of")).resolves.toEqual([]);
  });

  it("matches case-insensitively and ignores diacritics", async () => {
    await seed("user-1", "doc-1", ["Café résumé"]);

    expect(ids(await lexical("CAFE resume"))).toEqual(["doc-1-0"]);
  });
});

describe("SqliteVectorStore.getChunks", () => {
  it("hydrates text and file name for the requested chunks only, scoped to the owner", async () => {
    await seed("user-1", "doc-1", ["first", "second", "third"], "report.pdf");
    await seed("user-2", "doc-2", ["foreign"]);

    const chunks = await stores.vectorStore.getChunks("user-1", ["doc-1-2", "doc-1-0", "doc-2-0", "missing"]);

    expect(chunks.map((chunk) => chunk.chunkId).sort()).toEqual(["doc-1-0", "doc-1-2"]);
    expect(chunks.find((chunk) => chunk.chunkId === "doc-1-2")).toEqual({
      chunkId: "doc-1-2",
      documentId: "doc-1",
      fileName: "report.pdf",
      chunkIndex: 2,
      content: "third",
    });
  });

  it("returns nothing for an empty id list", async () => {
    expect(await stores.vectorStore.getChunks("user-1", [])).toEqual([]);
  });
});

describe("SqliteVectorStore chunks", () => {
  it("lists chunk text in reading order, scoped to the owner", async () => {
    await seed("user-1", "doc-1", ["a", "b", "c"]);

    expect(await stores.vectorStore.listByDocument("user-1", "doc-1")).toEqual([
      { chunkIndex: 0, content: "a" },
      { chunkIndex: 1, content: "b" },
      { chunkIndex: 2, content: "c" },
    ]);
    expect(await stores.vectorStore.listByDocument("user-2", "doc-1")).toEqual([]);
  });

  it("deleteByDocument only removes the owner's vectors and is idempotent", async () => {
    await seed("user-1", "doc-1", ["a"]);

    await stores.vectorStore.deleteByDocument("user-2", "doc-1");
    expect(count("document_chunks")).toBe(1);

    await stores.vectorStore.deleteByDocument("user-1", "doc-1");
    await stores.vectorStore.deleteByDocument("user-1", "doc-1");
    expect(count("document_chunks")).toBe(0);
    expect(count("documents")).toBe(1);
  });

  it("stores embeddings as float32 blobs with their dimension", async () => {
    await seed("user-1", "doc-1", [{ content: "a", embedding: [0.5, 0.25, 0, 1] }]);

    const row = stores.db.prepare("SELECT embedding, embedding_dim AS dim FROM document_chunks").get() as {
      embedding: Buffer;
      dim: number;
    };

    expect(row.dim).toBe(4);
    expect(row.embedding.equals(encodeVector([0.5, 0.25, 0, 1]))).toBe(true);
  });
});

describe("SqliteVectorStore.replaceEmbeddings", () => {
  beforeEach(async () => {
    await seed("user-1", "doc-1", ["alpha", "beta"].map((content) => ({ content, embedding: [1, 0, 0, 0], embeddingModel: "old" })));
  });

  it("swaps vectors and model for the whole document and keeps text, ids and the FTS index", async () => {
    await stores.vectorStore.replaceEmbeddings("user-1", "doc-1", "new-model", [
      { chunkIndex: 0, embedding: [0, 1, 0, 0] },
      { chunkIndex: 1, embedding: [0, 0, 1, 0, 0] },
    ]);

    const rows = stores.db
      .prepare("SELECT id, content, embedding_model AS model, embedding_dim AS dim FROM document_chunks ORDER BY chunk_index")
      .all();
    expect(rows).toEqual([
      { id: "doc-1-0", content: "alpha", model: "new-model", dim: 4 },
      { id: "doc-1-1", content: "beta", model: "new-model", dim: 5 },
    ]);
    expect(ids(await lexical("alpha"))).toEqual(["doc-1-0"]);
    expect(ids(await semantic({ embedding: [0, 1, 0, 0], embeddingModel: "new-model" }))).toEqual(["doc-1-0"]);
  });

  it("is all-or-nothing: an update that matches no chunk rolls everything back", async () => {
    await expect(
      stores.vectorStore.replaceEmbeddings("user-1", "doc-1", "new-model", [
        { chunkIndex: 0, embedding: [0, 1, 0, 0] },
        { chunkIndex: 7, embedding: [0, 1, 0, 0] }, // no such chunk
      ]),
    ).rejects.toThrow(/chunk/i);

    const models = stores.db.prepare("SELECT DISTINCT embedding_model AS m FROM document_chunks").all();
    expect(models).toEqual([{ m: "old" }]);
  });

  it("is all-or-nothing for invalid vectors too", async () => {
    await expect(
      stores.vectorStore.replaceEmbeddings("user-1", "doc-1", "new-model", [
        { chunkIndex: 0, embedding: [0, 1, 0, 0] },
        { chunkIndex: 1, embedding: [Number.NaN] },
      ]),
    ).rejects.toThrow();

    expect(stores.db.prepare("SELECT DISTINCT embedding_model AS m FROM document_chunks").all()).toEqual([{ m: "old" }]);
  });

  it("cannot touch another user's document", async () => {
    await expect(
      stores.vectorStore.replaceEmbeddings("user-2", "doc-1", "new-model", [{ chunkIndex: 0, embedding: [1, 0, 0, 0] }]),
    ).rejects.toThrow();

    expect(stores.db.prepare("SELECT DISTINCT embedding_model AS m FROM document_chunks").all()).toEqual([{ m: "old" }]);
  });
});

describe("SqliteIndexMaintenance.listIndexedDocuments", () => {
  it("counts stale chunks per document: other model, invalid vector, or unexpected dimension", async () => {
    await seed("user-1", "fresh", [{ content: "a" }]);
    await seed("user-1", "other-model", [{ content: "a", embeddingModel: "old" }, { content: "b" }]);
    await seed("user-2", "broken", [{ content: "a" }]);
    stores.db.prepare("UPDATE document_chunks SET embedding = x'', embedding_dim = 0 WHERE document_id = 'broken'").run();

    const byDocument = async (target: { model: string; dimension?: number }) =>
      Object.fromEntries(
        (await stores.maintenance.listIndexedDocuments(target)).map((item) => [item.documentId, [item.staleChunkCount, item.chunkCount]]),
      );

    expect(await byDocument({ model: "test-model" })).toEqual({ fresh: [0, 1], "other-model": [1, 2], broken: [1, 1] });
    expect(await byDocument({ model: "test-model", dimension: 8 })).toEqual({ fresh: [1, 1], "other-model": [2, 2], broken: [1, 1] });
  });

  it("reports owner and file name so each document can be re-indexed in its owner's scope", async () => {
    await seed("user-2", "doc-x", [{ content: "a" }], "x.pdf");

    expect(await stores.maintenance.listIndexedDocuments({ model: "test-model" })).toEqual([
      { userId: "user-2", documentId: "doc-x", fileName: "x.pdf", chunkCount: 1, staleChunkCount: 0 },
    ]);
  });
});

describe("lexical query plan", () => {
  it("is driven by the FTS index, not by a scan of the user's chunks", () => {
    const plan = stores.db
      .prepare(`EXPLAIN QUERY PLAN ${LEXICAL_SELECT} ORDER BY bm25(chunk_fts) LIMIT @limit`)
      .all({ match: '"x"', userId: "user-1", limit: 5 }) as Array<{ detail: string }>;

    expect(plan[0].detail).toContain("chunk_fts");
    expect(plan.some((step) => step.detail.includes("SEARCH c USING INTEGER PRIMARY KEY"))).toBe(true);
  });
});
