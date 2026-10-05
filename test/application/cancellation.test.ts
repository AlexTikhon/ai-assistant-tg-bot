import { describe, expect, it } from "vitest";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { SummarizeDocumentUseCase } from "../../src/application/use-cases/summarize-document.use-case.js";
import { Operations, OperationCancelledError } from "../../src/shared/operation.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, makeChunk, makeDocument, Utf8Extractor } from "../support/fakes.js";

const options = { maxUploadBytes: 100_000, chunkSize: 1000, chunkOverlap: 150, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 };

describe("cancelled application work", () => {
  it("does not persist an upload after an embedding provider ignores the deadline", async () => {
    const stores = createTestStores(); const files = new InMemoryFileStorage(); const operations = new Operations();
    let release!: (vectors: number[][]) => void;
    const vectors = new Promise<number[][]>((resolve) => { release = resolve; });
    const embeddings = { model: "test-model", embedQuery: async () => [1, 0], embedDocuments: async () => vectors };
    const ingest = new IngestDocumentUseCase({ ...stores, files, embeddings, extractor: new Utf8Extractor(), options });
    try {
      await expect(operations.run(10, () => ingest.execute({ userId: "u", fileName: "a.txt", mimeType: "text/plain", data: Buffer.from("cat") }))).rejects.toBeInstanceOf(OperationCancelledError);
      release([[1, 0]]); await operations.shutdown();
      expect(await stores.documents.listByUser("u")).toEqual([]);
      expect(files.files.size).toBe(0);
    } finally { stores.db.close(); }
  });

  it("joins a file write already in progress and compensates it before shutdown", async () => {
    const stores = createTestStores(); const files = new InMemoryFileStorage(); const operations = new Operations();
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalSave = files.save.bind(files);
    files.save = async (name, data) => { entered(); await gate; return originalSave(name, data); };
    const ingest = new IngestDocumentUseCase({ ...stores, files, embeddings: new KeywordEmbeddings(), extractor: new Utf8Extractor(), options });
    try {
      const pending = operations.run(30, () => ingest.execute({ userId: "u", fileName: "a.txt", mimeType: "text/plain", data: Buffer.from("cat") }));
      await started;
      await expect(pending).rejects.toBeInstanceOf(OperationCancelledError);
      expect(operations.activeCount).toBe(1);
      release(); await operations.shutdown();
      expect(files.files.size).toBe(0);
      expect(await stores.documents.listByUser("u")).toEqual([]);
    } finally { stores.db.close(); }
  });

  it("stops map-reduce summaries between calls and never caches the late output", async () => {
    const stores = createTestStores(); const operations = new Operations();
    await stores.documents.saveWithChunks(makeDocument({ id: "doc", userId: "u" }), Array.from({ length: 3 }, (_, i) => makeChunk({ id: `c${i}`, documentId: "doc", userId: "u", chunkIndex: i, content: "long document text ".repeat(5) })));
    let release!: (text: string) => void; let calls = 0;
    const generated = new Promise<string>((resolve) => { release = resolve; });
    const summary = new SummarizeDocumentUseCase({ ...stores, chatModel: { complete: async () => { calls += 1; return generated; } }, options: { directMaxChars: 50, groupMaxChars: 100 } });
    try {
      await expect(operations.run(10, () => summary.execute("u", "doc"))).rejects.toBeInstanceOf(OperationCancelledError);
      release("late partial summary"); await operations.shutdown();
      expect(calls).toBe(1);
      expect((await stores.documents.findById("u", "doc"))?.summary).toBeNull();
    } finally { stores.db.close(); }
  });
});
