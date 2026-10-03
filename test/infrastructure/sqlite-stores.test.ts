import { beforeEach, describe, expect, it } from "vitest";
import { createTestStores, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;

beforeEach(() => {
  stores = createTestStores();
});

function count(table: string) {
  return (stores.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

async function seed(userId: string, documentId: string, vectors: number[][], fileName = `${documentId}.txt`) {
  await stores.documents.saveWithChunks(
    makeDocument({ id: documentId, userId, fileName }),
    vectors.map((embedding, chunkIndex) =>
      makeChunk({ documentId, userId, chunkIndex, embedding, content: `${documentId} chunk ${chunkIndex}` }),
    ),
  );
}

const search = (overrides: Partial<Parameters<typeof stores.vectorStore.searchSimilar>[0]> = {}) =>
  stores.vectorStore.searchSimilar({
    userId: "user-1",
    embedding: [1, 0, 0, 0],
    embeddingModel: "test-model",
    topK: 5,
    minScore: 0.2,
    ...overrides,
  });

describe("SqliteDocumentRepository", () => {
  it("enables foreign keys on the connection", () => {
    expect(stores.db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("saves a document with all of its chunks", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0], [0, 1, 0, 0]]);

    expect(count("documents")).toBe(1);
    expect(count("document_chunks")).toBe(2);
    expect(await stores.documents.findById("user-1", "doc-1")).toMatchObject({ fileName: "doc-1.txt", summary: null });
  });

  it("is atomic: a failing chunk insert leaves neither the document nor other chunks behind", async () => {
    const duplicateIndex = [
      makeChunk({ chunkIndex: 0 }),
      makeChunk({ chunkIndex: 0 }), // violates UNIQUE (document_id, chunk_index)
    ];

    await expect(stores.documents.saveWithChunks(makeDocument(), duplicateIndex)).rejects.toThrow();

    expect(count("documents")).toBe(0);
    expect(count("document_chunks")).toBe(0);
  });

  it("rejects chunks that point to a missing document (foreign key)", async () => {
    await expect(
      stores.vectorStore.upsertChunks([makeChunk({ documentId: "missing" })]),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("lists only the requesting user's documents, newest first", async () => {
    await stores.documents.saveWithChunks(makeDocument({ id: "old", createdAt: "2026-01-01T00:00:00.000Z" }), []);
    await stores.documents.saveWithChunks(makeDocument({ id: "new", createdAt: "2026-02-01T00:00:00.000Z" }), []);
    await stores.documents.saveWithChunks(makeDocument({ id: "other", userId: "user-2" }), []);

    const documents = await stores.documents.listByUser("user-1");

    expect(documents.map((document) => document.id)).toEqual(["new", "old"]);
  });

  it("does not expose a document to another user", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0]]);

    expect(await stores.documents.findById("user-2", "doc-1")).toBeNull();
  });

  it("deletes a document and its chunks with one operation (ON DELETE CASCADE)", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0], [0, 1, 0, 0]]);

    expect(await stores.documents.delete("user-1", "doc-1")).toBe(true);

    expect(count("documents")).toBe(0);
    expect(count("document_chunks")).toBe(0);
  });

  it("refuses to delete (or touch) another user's document", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0]]);

    expect(await stores.documents.delete("user-2", "doc-1")).toBe(false);
    await stores.documents.updateSummary("user-2", "doc-1", "hacked");

    expect(count("documents")).toBe(1);
    expect(count("document_chunks")).toBe(1);
    expect((await stores.documents.findById("user-1", "doc-1"))?.summary).toBeNull();
  });

  it("stores and returns the summary", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0]]);

    await stores.documents.updateSummary("user-1", "doc-1", "A short summary.");

    expect((await stores.documents.findById("user-1", "doc-1"))?.summary).toBe("A short summary.");
  });
});

describe("SqliteVectorStore.searchSimilar", () => {
  it("ranks by similarity, applies topK and maps structured source data", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0], [1, 1, 0, 0], [0, 0, 1, 0]], "report.pdf");

    const results = await search({ topK: 2 });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ documentId: "doc-1", fileName: "report.pdf", chunkIndex: 0 });
    expect(results[0].score).toBeCloseTo(1);
    expect(results[1]).toMatchObject({ chunkIndex: 1 });
    expect(results[1].score).toBeCloseTo(Math.SQRT1_2);
    expect(results[0].content).toBe("doc-1 chunk 0");
  });

  it("filters out chunks below minScore", async () => {
    await seed("user-1", "doc-1", [[0, 1, 0, 0]]);

    expect(await search()).toEqual([]);
  });

  it("never returns another user's chunks, even if they match perfectly", async () => {
    await seed("user-1", "doc-1", [[0, 1, 0, 0]]);
    await seed("user-2", "doc-2", [[1, 0, 0, 0]]);

    expect(await search({ userId: "user-1" })).toEqual([]);
    expect((await search({ userId: "user-2" })).map((result) => result.documentId)).toEqual(["doc-2"]);
  });

  it("does not leak across users even when a documentId of another user is requested", async () => {
    await seed("user-2", "doc-2", [[1, 0, 0, 0]]);

    expect(await search({ userId: "user-1", documentId: "doc-2" })).toEqual([]);
  });

  it("can be scoped to one document", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0]]);
    await seed("user-1", "doc-2", [[1, 0, 0, 0]]);

    const results = await search({ documentId: "doc-2" });

    expect(results.map((result) => result.documentId)).toEqual(["doc-2"]);
  });

  it("ignores chunks that were embedded with a different model", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0]]);

    expect(await search({ embeddingModel: "another-model" })).toEqual([]);
  });

  it("skips chunks whose dimension differs from the query instead of failing or mis-scoring", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0]]);
    await stores.vectorStore.upsertChunks([
      makeChunk({ documentId: "doc-1", chunkIndex: 1, embedding: [1, 0, 0, 0, 0, 0] }), // same model, wrong size
    ]);

    const results = await search();

    expect(results.map((result) => result.chunkIndex)).toEqual([0]);
  });

  it("skips chunks with corrupted embedding JSON", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0], [1, 0, 0, 0]]);
    stores.db.prepare("UPDATE document_chunks SET embedding = ? WHERE chunk_index = 1").run("{not json");

    const results = await search();

    expect(results.map((result) => result.chunkIndex)).toEqual([0]);
  });

  it("skips stored vectors containing non-finite values", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0], [1, 0, 0, 0]]);
    stores.db.prepare("UPDATE document_chunks SET embedding = ? WHERE chunk_index = 1").run("[1,null,0,0]");

    const results = await search();

    expect(results.map((result) => result.chunkIndex)).toEqual([0]);
  });
});

describe("SqliteVectorStore chunks", () => {
  it("upserts by (documentId, chunkIndex): replaces content, vector and model, keeps the row count", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0]]);

    await stores.vectorStore.upsertChunks([
      makeChunk({ documentId: "doc-1", chunkIndex: 0, content: "new text", embedding: [0, 1, 0, 0], embeddingModel: "model-2" }),
    ]);

    expect(count("document_chunks")).toBe(1);
    expect(await search({ embeddingModel: "test-model" })).toEqual([]);
    const [match] = await search({ embedding: [0, 1, 0, 0], embeddingModel: "model-2" });
    expect(match).toMatchObject({ content: "new text", chunkIndex: 0 });
  });

  it("lists chunk text in reading order, scoped to the owner", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]);

    expect(await stores.vectorStore.listByDocument("user-1", "doc-1")).toEqual([
      { chunkIndex: 0, content: "doc-1 chunk 0" },
      { chunkIndex: 1, content: "doc-1 chunk 1" },
      { chunkIndex: 2, content: "doc-1 chunk 2" },
    ]);
    expect(await stores.vectorStore.listByDocument("user-2", "doc-1")).toEqual([]);
  });

  it("deleteByDocument only removes the owner's vectors and is idempotent", async () => {
    await seed("user-1", "doc-1", [[1, 0, 0, 0]]);

    await stores.vectorStore.deleteByDocument("user-2", "doc-1");
    expect(count("document_chunks")).toBe(1);

    await stores.vectorStore.deleteByDocument("user-1", "doc-1");
    await stores.vectorStore.deleteByDocument("user-1", "doc-1");
    expect(count("document_chunks")).toBe(0);
    expect(count("documents")).toBe(1);
  });
});
