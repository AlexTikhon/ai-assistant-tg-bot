import { beforeEach, describe, expect, it } from "vitest";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import type { IngestDocumentResult } from "../../src/application/use-cases/ingest-document.use-case.js";
import { hashContent } from "../../src/core/content-hash.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;
let embeddings: KeywordEmbeddings;
let extractor: Utf8Extractor;

const options = {
  maxUploadBytes: 100_000,
  chunkSize: 200,
  chunkOverlap: 20,
  maxDocumentsPerUser: 10,
  maxStorageBytesPerUser: 1_000_000,
  maxChunksPerDocument: 100,
};

const TEXT = "The cat sleeps all day. The dog barks at the cat. ".repeat(10);

function createUseCase(overrides: Partial<typeof options> = {}, model?: string) {
  return new IngestDocumentUseCase({
    documents: stores.documents,
    files,
    extractor,
    embeddings: model ? new KeywordEmbeddings(["cat", "dog", "tax", "space"], model) : embeddings,
    options: { ...options, ...overrides },
  });
}

const upload = (overrides: Partial<{ userId: string; fileName: string; text: string }> = {}) => ({
  userId: overrides.userId ?? "user-1",
  fileName: overrides.fileName ?? "pets.txt",
  mimeType: "text/plain",
  data: Buffer.from(overrides.text ?? TEXT),
});

const count = (table: string) => (stores.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function expectKind<K extends IngestDocumentResult["kind"]>(result: IngestDocumentResult, kind: K) {
  expect(result.kind).toBe(kind);
  return result as Extract<IngestDocumentResult, { kind: K }>;
}

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  embeddings = new KeywordEmbeddings();
  extractor = new Utf8Extractor();
});

describe("ingestion result model", () => {
  it("a new document is reported as created, with its identity and size", async () => {
    const result = expectKind(await createUseCase().execute(upload()), "created");

    expect(result).toMatchObject({ fileName: "pets.txt", documentId: expect.any(String), chunksCount: expect.any(Number) });
    expect(result.chunksCount).toBeGreaterThan(1);
  });

  it("records the content hash, version 1 and no replacement history", async () => {
    const result = await createUseCase().execute(upload());

    expect(await stores.documents.findById("user-1", result.documentId)).toMatchObject({
      contentHash: hashContent(Buffer.from(TEXT)),
      documentVersion: 1,
      previousContentHash: null,
    });
  });
});

describe("idempotent ingestion", () => {
  it("returns already-exists with the existing identity when the same user uploads the same bytes again", async () => {
    const first = await createUseCase().execute(upload());

    const second = expectKind(await createUseCase().execute(upload()), "already-exists");

    expect(second).toMatchObject({ documentId: first.documentId, fileName: "pets.txt", chunksCount: first.chunksCount });
    expect(second.health.state).toBe("current");
  });

  it("spends nothing on a duplicate: no extraction, no embedding call, no file, no rows", async () => {
    await createUseCase().execute(upload());
    const before = { extractions: extractor.calls, embeddingCalls: embeddings.documentCalls.length, files: files.files.size, documents: count("documents"), chunks: count("document_chunks") };

    await createUseCase().execute(upload());

    expect({ extractions: extractor.calls, embeddingCalls: embeddings.documentCalls.length, files: files.files.size, documents: count("documents"), chunks: count("document_chunks") }).toEqual(before);
  });

  it("recognises the same bytes under a different file name (identity is content, not the name)", async () => {
    const first = await createUseCase().execute(upload({ fileName: "pets.txt" }));

    const second = expectKind(await createUseCase().execute(upload({ fileName: "renamed-copy.txt" })), "already-exists");

    expect(second.documentId).toBe(first.documentId);
    expect(second.fileName).toBe("pets.txt"); // the user's existing document, as it is stored
    expect(count("documents")).toBe(1);
  });

  it("does not treat the same file name with different bytes as a duplicate: both documents are kept under their own ids", async () => {
    const first = await createUseCase().execute(upload({ fileName: "notes.txt", text: "version one about the cat. ".repeat(10) }));

    const second = expectKind(await createUseCase().execute(upload({ fileName: "notes.txt", text: "version two about the dog. ".repeat(10) })), "created");

    expect(second.documentId).not.toBe(first.documentId);
    expect(count("documents")).toBe(2);
    expect(files.files.size).toBe(2);
  });

  it("deduplicates per user: another user ingests the same bytes independently", async () => {
    const first = await createUseCase().execute(upload({ userId: "user-1" }));

    const other = expectKind(await createUseCase().execute(upload({ userId: "user-2" })), "created");

    expect(other.documentId).not.toBe(first.documentId);
    expect(await stores.documents.listByUser("user-2")).toHaveLength(1);
    expect(embeddings.documentCalls.length).toBeGreaterThan(1); // user 2 really was indexed: no cross-user shortcut
  });

  it("never reveals another user's document: an upload only ever matches the uploader's own documents", async () => {
    await createUseCase().execute(upload({ userId: "user-1" }));

    const result = await createUseCase().execute(upload({ userId: "user-2" }));

    expect(result.kind).toBe("created");
    expect(await stores.documents.findByContentHash("user-2", hashContent(Buffer.from(TEXT)))).toMatchObject({ userId: "user-2" });
  });

  it("is idempotent under concurrency: two simultaneous identical uploads create one document", async () => {
    const useCase = createUseCase();

    const results = await Promise.all([useCase.execute(upload()), useCase.execute(upload())]);

    expect(results.map((result) => result.kind).sort()).toEqual(["already-exists", "created"]);
    expect(count("documents")).toBe(1);
  });

  it("answers a duplicate even when the user is at their document limit", async () => {
    const useCase = createUseCase({ maxDocumentsPerUser: 1 });
    await useCase.execute(upload());

    expect((await useCase.execute(upload())).kind).toBe("already-exists");
  });

  it("still reports a duplicate whose index is outdated, without re-embedding it (repair is an explicit operator action)", async () => {
    await createUseCase().execute(upload());
    embeddings.documentCalls.length = 0;

    const second = expectKind(await createUseCase({}, "newer-model").execute(upload()), "already-exists");

    expect(second.health.issues).toContain("embedding-stale");
    expect(embeddings.documentCalls).toHaveLength(0);
    expect(count("documents")).toBe(1);
  });

  it("reports a duplicate without chunks as unindexed instead of pretending it is searchable", async () => {
    const first = await createUseCase().execute(upload());
    stores.db.prepare("DELETE FROM document_chunks").run();

    const second = expectKind(await createUseCase().execute(upload()), "already-exists");

    expect(second).toMatchObject({ documentId: first.documentId, chunksCount: 0 });
    expect(second.health.state).toBe("unindexed");
  });
});

describe("historical documents without a recorded hash", () => {
  async function seedLegacy(text = TEXT) {
    const stored = await createUseCase().execute(upload({ text }));
    stores.db.prepare("UPDATE documents SET content_hash = NULL WHERE id = ?").run(stored.documentId);
    return stored;
  }

  it("are recognised lazily: the stored original is hashed once, compared, and the hash is kept", async () => {
    const legacy = await seedLegacy();

    const second = expectKind(await createUseCase().execute(upload()), "already-exists");

    expect(second.documentId).toBe(legacy.documentId);
    expect((await stores.documents.findById("user-1", legacy.documentId))?.contentHash).toBe(hashContent(Buffer.from(TEXT)));
  });

  it("only read candidates of the same size, and never again once hashed", async () => {
    await seedLegacy("other bytes, other size. ".repeat(3));
    const reads: string[] = [];
    const read = files.read.bind(files);
    files.read = async (name) => (reads.push(name), read(name));

    const created = await createUseCase().execute(upload());

    expect(created.kind).toBe("created");
    expect(reads).toEqual([]); // a different size cannot be the same content: no file was read
  });

  it("do not block an upload when their original file is missing: the hash stays unknown", async () => {
    const legacy = await seedLegacy();
    files.files.clear();

    const second = await createUseCase().execute(upload());

    expect(second.kind).toBe("created"); // cannot prove it is a duplicate; failing the upload would be worse
    expect((await stores.documents.findById("user-1", legacy.documentId))?.contentHash).toBeNull();
  });

  it("do not match another user's legacy document", async () => {
    await seedLegacy();

    const other = await createUseCase().execute(upload({ userId: "user-2" }));

    expect(other.kind).toBe("created");
  });
});

describe("a duplicate upload restores a missing original (no re-indexing)", () => {
  it("writes the file again, points the document at it, and still spends nothing on extraction or embeddings", async () => {
    const first = await createUseCase().execute(upload());
    const before = await stores.documents.findById("user-1", first.documentId);
    files.files.delete(before!.storedName);
    embeddings.documentCalls.length = 0;
    const extractions = extractor.calls;

    const second = expectKind(await createUseCase().execute(upload()), "already-exists");

    expect(second.restoredOriginal).toBe(true);
    const after = await stores.documents.findById("user-1", first.documentId);
    expect(after?.storedName).not.toBe(before?.storedName);
    expect(files.files.get(after!.storedName)?.equals(Buffer.from(TEXT))).toBe(true);
    expect(embeddings.documentCalls).toHaveLength(0);
    expect(extractor.calls).toBe(extractions);
    expect(after).toMatchObject({ contentHash: before?.contentHash, documentVersion: 1, updatedAt: null });
    expect(count("document_chunks")).toBe(first.chunksCount);
  });

  it("leaves a present original alone", async () => {
    const first = await createUseCase().execute(upload());
    const before = await stores.documents.findById("user-1", first.documentId);

    const second = expectKind(await createUseCase().execute(upload()), "already-exists");

    expect(second.restoredOriginal).toBeUndefined();
    expect((await stores.documents.findById("user-1", first.documentId))?.storedName).toBe(before?.storedName);
    expect(files.files.size).toBe(1);
  });

  it("does not fail the upload when the file cannot be written: it is still reported as a duplicate, and nothing is left behind", async () => {
    const first = await createUseCase().execute(upload());
    const before = await stores.documents.findById("user-1", first.documentId);
    files.files.delete(before!.storedName);
    files.failOnSave = true;

    const second = expectKind(await createUseCase().execute(upload()), "already-exists");

    expect(second.restoredOriginal).toBeUndefined();
    expect((await stores.documents.findById("user-1", first.documentId))?.storedName).toBe(before?.storedName);
    expect(files.files.size).toBe(0);
  });

  it("removes the newly written file when pointing the document at it fails", async () => {
    const first = await createUseCase().execute(upload());
    const before = await stores.documents.findById("user-1", first.documentId);
    files.files.delete(before!.storedName);
    const failing = Object.create(stores.documents, { updateStoredName: { value: async () => Promise.reject(new Error("database is locked")) } });

    const second = await new IngestDocumentUseCase({ documents: failing, files, extractor, embeddings, options }).execute(upload());

    expect(second.kind).toBe("already-exists");
    expect(files.files.size).toBe(0);
  });

  it("never restores from another user's upload", async () => {
    const first = await createUseCase().execute(upload({ userId: "user-1" }));
    const before = await stores.documents.findById("user-1", first.documentId);
    files.files.delete(before!.storedName);

    await createUseCase().execute(upload({ userId: "user-2" })); // same bytes, other user: a new document of theirs

    expect((await stores.documents.findById("user-1", first.documentId))?.storedName).toBe(before?.storedName);
  });
});
