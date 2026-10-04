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
      stores.documents.saveWithChunks(makeDocument(), [makeChunk({ documentId: "missing" })]),
    ).rejects.toThrow(/FOREIGN KEY/);
    expect(count("documents")).toBe(0);
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
