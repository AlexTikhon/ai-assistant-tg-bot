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

describe("DeleteDocumentUseCase: partial failures keep the database consistent", () => {
  it("a failing database deletion leaves the document, its chunks and its file untouched, and reports the error", async () => {
    const failingDocuments = Object.create(stores.documents, {
      delete: { value: async () => Promise.reject(new Error("database is locked")) },
    });

    await expect(new DeleteDocumentUseCase({ ...stores, documents: failingDocuments, files }).execute("user-1", "doc-1")).rejects.toThrow("database is locked");

    expect(rowCount("documents")).toBe(1);
    expect(rowCount("document_chunks")).toBe(1);
    expect(files.files.size).toBe(1); // the file is only removed after the row is gone: nothing was lost
  });

  it("a failing vector cleanup does not undo or fail a completed deletion", async () => {
    const failingVectors = Object.create(stores.vectorStore, {
      deleteByDocument: { value: async () => Promise.reject(new Error("index unavailable")) },
    });

    await expect(new DeleteDocumentUseCase({ ...stores, vectorStore: failingVectors, files }).execute("user-1", "doc-1")).resolves.toBeUndefined();

    expect(rowCount("documents")).toBe(0);
    expect(files.files.size).toBe(0);
  });

  it("removes the file only after the document row is gone (never the other way round)", async () => {
    const order: string[] = [];
    const documents = Object.create(stores.documents, {
      delete: {
        value: async (userId: string, documentId: string) => {
          const result = await stores.documents.delete(userId, documentId);
          order.push("row-deleted");
          return result;
        },
      },
    });
    const remove = files.delete.bind(files);
    files.delete = async (name) => (order.push("file-deleted"), remove(name));

    await new DeleteDocumentUseCase({ ...stores, documents, files }).execute("user-1", "doc-1");

    expect(order).toEqual(["row-deleted", "file-deleted"]);
  });

  it("an already missing file is not an error", async () => {
    files.files.clear();

    await expect(new DeleteDocumentUseCase({ ...stores, files }).execute("user-1", "doc-1")).resolves.toBeUndefined();

    expect(rowCount("documents")).toBe(0);
  });
});

describe("DeleteDocumentUseCase and replacement of the same document", () => {
  it("waits for a running replacement instead of racing it, so no new file is orphaned", async () => {
    const { ReplaceDocumentUseCase } = await import("../../src/application/use-cases/replace-document.use-case.js");
    const { KeyedMutex } = await import("../../src/shared/keyed-mutex.js");
    const { KeywordEmbeddings, Utf8Extractor } = await import("../support/fakes.js");
    const locks = new KeyedMutex();
    const embeddings = new KeywordEmbeddings();
    let releaseEmbedding!: () => void;
    const gate = new Promise<void>((resolve) => (releaseEmbedding = resolve));
    const embed = embeddings.embedDocuments.bind(embeddings);
    embeddings.embedDocuments = async (texts) => (await gate, embed(texts));

    const replace = new ReplaceDocumentUseCase({
      documents: stores.documents,
      files,
      extractor: new Utf8Extractor(),
      embeddings,
      locks,
      options: { maxUploadBytes: 10_000, chunkSize: 200, chunkOverlap: 20, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 50 },
    });
    const replacing = replace.execute({ userId: "user-1", documentId: "doc-1", fileName: "new.txt", mimeType: "text/plain", data: Buffer.from("brand new text about tax") });
    const deleting = new DeleteDocumentUseCase({ ...stores, files, locks }).execute("user-1", "doc-1");

    releaseEmbedding();
    await Promise.all([replacing, deleting]);

    expect(rowCount("documents")).toBe(0);
    expect(files.files.size).toBe(0); // neither the old nor the new file is left behind
  });
});
