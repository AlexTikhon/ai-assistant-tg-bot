import { beforeEach, describe, expect, it } from "vitest";
import type { DocumentRepository } from "../../src/application/ports/document-repository.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { ValidationError } from "../../src/shared/errors.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;
let embeddings: KeywordEmbeddings;

const options = {
  maxUploadBytes: 1024,
  chunkSize: 200,
  chunkOverlap: 20,
  maxDocumentsPerUser: 10,
  maxStorageBytesPerUser: 1_000_000,
  maxChunksPerDocument: 100,
};

function createUseCase(documents: DocumentRepository = stores.documents, overrides: Partial<typeof options> = {}) {
  return new IngestDocumentUseCase({
    documents,
    files,
    extractor: new Utf8Extractor(),
    embeddings,
    options: { ...options, ...overrides },
  });
}

const upload = (overrides: Partial<{ userId: string; fileName: string; text: string }> = {}) => ({
  userId: overrides.userId ?? "user-1",
  fileName: overrides.fileName ?? "pets.txt",
  mimeType: "text/plain",
  data: Buffer.from(overrides.text ?? "The cat sleeps all day. The dog barks at the cat. ".repeat(10)),
});

function rowCount(table: string) {
  return (stores.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  embeddings = new KeywordEmbeddings();
});

describe("IngestDocumentUseCase", () => {
  it("stores the file, the document and its embedded chunks", async () => {
    const result = await createUseCase().execute(upload());

    expect(result.chunksCount).toBeGreaterThan(1);
    expect(files.files.size).toBe(1);
    expect(rowCount("documents")).toBe(1);
    expect(rowCount("document_chunks")).toBe(result.chunksCount);

    const document = await stores.documents.findById("user-1", result.documentId);
    expect(document).toMatchObject({ fileName: "pets.txt", userId: "user-1" });
    expect([...files.files.keys()]).toEqual([document?.storedName]);
  });

  it("records the embedding model with every chunk", async () => {
    embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], "embed-v9");
    await createUseCase().execute(upload());

    const models = stores.db.prepare("SELECT DISTINCT embedding_model AS m FROM document_chunks").all();
    expect(models).toEqual([{ m: "embed-v9" }]);
  });

  it("rejects unsupported file types before doing any work", async () => {
    await expect(createUseCase().execute(upload({ fileName: "virus.exe" }))).rejects.toThrow(ValidationError);

    expect(embeddings.documentCalls).toHaveLength(0);
    expect(files.files.size).toBe(0);
  });

  it("rejects oversized uploads before parsing or embedding", async () => {
    const tooBig = upload({ text: "x".repeat(options.maxUploadBytes + 1) });

    await expect(createUseCase().execute(tooBig)).rejects.toThrow(/too large/);
    expect(embeddings.documentCalls).toHaveLength(0);
    expect(files.files.size).toBe(0);
  });

  it("rejects empty and text-less files", async () => {
    await expect(createUseCase().execute(upload({ text: "" }))).rejects.toThrow(/empty/);
    await expect(createUseCase().execute(upload({ text: "  \n \n  " }))).rejects.toThrow(/Could not extract text/);
    expect(rowCount("documents")).toBe(0);
  });

  it("leaves nothing behind when embedding fails (no file, no rows)", async () => {
    embeddings.failWith = new Error("provider down");

    await expect(createUseCase().execute(upload())).rejects.toThrow("provider down");

    expect(files.files.size).toBe(0);
    expect(rowCount("documents")).toBe(0);
    expect(rowCount("document_chunks")).toBe(0);
  });

  it("rejects a provider that returns the wrong number of vectors, without saving anything", async () => {
    embeddings.documentVectorsOverride = [[1, 0, 0, 0]]; // fewer vectors than chunks

    await expect(createUseCase().execute(upload())).rejects.toThrow(/temporarily unavailable/);

    expect(files.files.size).toBe(0);
    expect(rowCount("documents")).toBe(0);
  });

  it("rejects non-finite vectors", async () => {
    embeddings.documentVectorsOverride = [[Number.NaN, 0, 0, 0]];

    await expect(createUseCase().execute(upload({ text: "short text about a cat" }))).rejects.toThrow(
      /temporarily unavailable/,
    );
    expect(files.files.size).toBe(0);
  });

  it("removes the stored file when persisting fails (compensation)", async () => {
    const failingRepository = {
      getUsage: async () => ({ documentCount: 0, totalBytes: 0 }),
      saveWithChunks: async () => {
        throw new Error("database is locked");
      },
    } as unknown as DocumentRepository;

    await expect(createUseCase(failingRepository).execute(upload())).rejects.toThrow("database is locked");

    expect(files.files.size).toBe(0);
    expect(rowCount("documents")).toBe(0);
  });

  it("still reports the original persistence error if file cleanup also fails", async () => {
    files.failOnDelete = true;
    const failingRepository = {
      getUsage: async () => ({ documentCount: 0, totalBytes: 0 }),
      saveWithChunks: async () => {
        throw new Error("database is locked");
      },
    } as unknown as DocumentRepository;

    await expect(createUseCase(failingRepository).execute(upload())).rejects.toThrow("database is locked");
  });

  it("does not write database records when the file cannot be saved", async () => {
    files.failOnSave = true;

    await expect(createUseCase().execute(upload())).rejects.toThrow("disk full");

    expect(rowCount("documents")).toBe(0);
    expect(rowCount("document_chunks")).toBe(0);
  });

  it("keeps documents of different users separate", async () => {
    await createUseCase().execute(upload({ userId: "user-1" }));
    await createUseCase().execute(upload({ userId: "user-2" }));

    expect(await stores.documents.listByUser("user-1")).toHaveLength(1);
    expect(await stores.documents.listByUser("user-2")).toHaveLength(1);
  });
});

describe("IngestDocumentUseCase per-user limits", () => {
  it("rejects an upload beyond the document limit, before extracting or embedding anything", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 2 });
    await useCase.execute(upload({ fileName: "one.txt" }));
    await useCase.execute(upload({ fileName: "two.txt" }));
    embeddings.documentCalls.length = 0;

    await expect(useCase.execute(upload({ fileName: "three.txt" }))).rejects.toThrow(/at most 2 documents/);

    expect(embeddings.documentCalls).toHaveLength(0);
    expect(files.files.size).toBe(2);
    expect(rowCount("documents")).toBe(2);
  });

  it("counts documents per user: another user's uploads do not use up my quota", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 1 });
    await useCase.execute(upload({ userId: "user-1" }));

    await expect(useCase.execute(upload({ userId: "user-2" }))).resolves.toMatchObject({ chunksCount: expect.any(Number) });
    await expect(useCase.execute(upload({ userId: "user-1" }))).rejects.toThrow(ValidationError);
  });

  it("rejects an upload that would push the user's stored bytes over the storage limit", async () => {
    const text = "x".repeat(300);
    const useCase = createUseCase(stores.documents, { maxStorageBytesPerUser: 700 });
    await useCase.execute(upload({ text }));
    await useCase.execute(upload({ text }));
    embeddings.documentCalls.length = 0;

    await expect(useCase.execute(upload({ text }))).rejects.toThrow(/storage limit/);

    expect(embeddings.documentCalls).toHaveLength(0);
    expect(rowCount("documents")).toBe(2);
  });

  it("deleting a document frees its quota", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 1 });
    const { documentId } = await useCase.execute(upload());
    await stores.documents.delete("user-1", documentId);

    await expect(useCase.execute(upload())).resolves.toBeDefined();
  });

  it("rejects a document that splits into too many chunks before paying for embeddings", async () => {
    const useCase = createUseCase(stores.documents, { maxChunksPerDocument: 2 });

    await expect(useCase.execute(upload({ text: "word ".repeat(150) }))).rejects.toThrow(/too large to index|chunks/);

    expect(embeddings.documentCalls).toHaveLength(0);
    expect(files.files.size).toBe(0);
    expect(rowCount("documents")).toBe(0);
  });

  it("serializes simultaneous uploads of one user so the limit cannot be raced", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 1 });

    const results = await Promise.allSettled([
      useCase.execute(upload({ fileName: "a.txt" })),
      useCase.execute(upload({ fileName: "b.txt" })),
      useCase.execute(upload({ fileName: "c.txt" })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(rowCount("documents")).toBe(1);
  });

  it("does not make different users wait for each other", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 1 });

    const results = await Promise.allSettled([
      useCase.execute(upload({ userId: "user-1" })),
      useCase.execute(upload({ userId: "user-2" })),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
  });
});
