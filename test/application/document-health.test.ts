import { beforeEach, describe, expect, it } from "vitest";
import { assessDocument, healthOf } from "../../src/application/assess-index.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;

const recipe = { embeddingModel: "test-model", chunkSize: 200, chunkOverlap: 20 };
const target = { model: "test-model" };

async function ingest(userId: string, fileName: string, text: string) {
  const result = await new IngestDocumentUseCase({
    documents: stores.documents,
    files: new InMemoryFileStorage(),
    extractor: new Utf8Extractor(),
    embeddings: new KeywordEmbeddings(),
    options: {
      maxUploadBytes: 100_000,
      chunkSize: 200,
      chunkOverlap: 20,
      maxDocumentsPerUser: 10,
      maxStorageBytesPerUser: 1_000_000,
      maxChunksPerDocument: 100,
    },
  }).execute({ userId, fileName, mimeType: "text/plain", data: Buffer.from(text) });
  return result.documentId;
}

async function healthFor(userId: string, documentId: string, active = recipe, fileMissing: boolean | null = false) {
  const documents = await stores.maintenance.listIndexedDocuments(target, { userId });
  const document = documents.find((item) => item.documentId === documentId)!;
  return healthOf(assessDocument(document, active), fileMissing);
}

beforeEach(() => {
  stores = createTestStores();
});

describe("per-user index view", () => {
  it("lists only the asked user's documents when a user is given", async () => {
    await ingest("u1", "a.txt", "cat text");
    await ingest("u2", "b.txt", "dog text");

    expect((await stores.maintenance.listIndexedDocuments(target, { userId: "u1" })).map((d) => d.fileName)).toEqual(["a.txt"]);
    expect(await stores.maintenance.listIndexedDocuments(target)).toHaveLength(2);
  });
});

describe("document index health, derived from metadata, chunks and the file system", () => {
  it("current: indexed with the configured recipe and the file is present", async () => {
    const id = await ingest("u1", "a.txt", "The cat sleeps. ".repeat(30));

    expect(await healthFor("u1", id)).toEqual({ state: "current", issues: [] });
  });

  it("embedding-stale: the configured embeddings model changed", async () => {
    const id = await ingest("u1", "a.txt", "cat");

    expect((await healthFor("u1", id, { ...recipe, embeddingModel: "other-model" })).issues).toContain("embedding-stale");
  });

  it("chunking-stale: the configured chunk size changed", async () => {
    const id = await ingest("u1", "a.txt", "cat");

    expect((await healthFor("u1", id, { ...recipe, chunkSize: 500 })).state).toBe("chunking-stale");
  });

  it("extractor-stale: an older recipe than the current extractor (Markdown without section provenance)", async () => {
    const id = await ingest("u1", "api.md", "# Title\n\ncat");
    stores.db
      .prepare("UPDATE documents SET index_profile = json_set(index_profile, '$.extractorVersion', 'text-v1') WHERE id = ?")
      .run(id);

    expect((await healthFor("u1", id)).state).toBe("extractor-stale");
  });

  it("corrupt-index: a stored vector cannot be decoded", async () => {
    const id = await ingest("u1", "a.txt", "cat");
    stores.db.prepare("UPDATE document_chunks SET embedding = x'0102' WHERE document_id = ?").run(id);

    const health = await healthFor("u1", id);

    expect(health.state).toBe("corrupt-index");
    // Unreadable vectors are corruption, not "another model": they are not also reported as stale embeddings.
    expect(health.issues).not.toContain("embedding-stale");
  });

  it("unindexed: the document has no chunks", async () => {
    const id = await ingest("u1", "a.txt", "cat");
    stores.db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);

    expect(await healthFor("u1", id)).toEqual({ state: "unindexed", issues: ["unindexed"] });
  });

  it("missing-file: the original is gone but the index is fine", async () => {
    const id = await ingest("u1", "a.txt", "cat");

    expect(await healthFor("u1", id, recipe, true)).toEqual({ state: "missing-file", issues: ["missing-file"] });
  });
});
