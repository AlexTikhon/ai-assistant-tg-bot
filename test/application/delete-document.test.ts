import { beforeEach, describe, expect, it } from "vitest";
import { DeleteDocumentUseCase } from "../../src/application/use-cases/delete-document.use-case.js";
import { NotFoundError } from "../../src/shared/errors.js";
import { createTestStores, InMemoryFileStorage, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;

function rowCount(table: string) {
  return (stores.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(async () => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  files.files.set("stored-1", Buffer.from("data"));
  await stores.documents.saveWithChunks(makeDocument({ id: "doc-1", storedName: "stored-1" }), [
    makeChunk({ documentId: "doc-1", chunkIndex: 0, content: "the cat sleeps", embedding: [1, 0, 0, 0] }),
  ]);
});

describe("DeleteDocumentUseCase", () => {
  const createUseCase = () => new DeleteDocumentUseCase({ ...stores, files });

  it("deletes the document, its chunks and its file", async () => {
    await createUseCase().execute("user-1", "doc-1");

    expect(rowCount("documents")).toBe(0);
    expect(rowCount("document_chunks")).toBe(0);
    expect(files.files.size).toBe(0);
  });

  it("does not let another user delete the document (nothing is removed)", async () => {
    await expect(createUseCase().execute("user-2", "doc-1")).rejects.toThrow(NotFoundError);

    expect(rowCount("documents")).toBe(1);
    expect(rowCount("document_chunks")).toBe(1);
    expect(files.files.size).toBe(1);
  });

  it("reports unknown documents", async () => {
    await expect(createUseCase().execute("user-1", "nope")).rejects.toThrow(NotFoundError);
  });

  it("completes the deletion even if removing the file fails (database is the source of truth)", async () => {
    files.failOnDelete = true;

    await expect(createUseCase().execute("user-1", "doc-1")).resolves.toBeUndefined();

    expect(rowCount("documents")).toBe(0);
    expect(rowCount("document_chunks")).toBe(0);
    expect(files.files.size).toBe(1); // orphaned file: logged, not fatal
  });
});

describe("DeleteDocumentUseCase and the full-text index", () => {
  it("removes the document's chunks from keyword search", async () => {
    const hits = () =>
      stores.vectorStore.searchLexical({ userId: "user-1", query: "sleeps", limit: 5 }).then((matches) => matches.length);
    expect(await hits()).toBe(1);

    await new DeleteDocumentUseCase({ ...stores, files }).execute("user-1", "doc-1");

    expect(await hits()).toBe(0);
  });
});
