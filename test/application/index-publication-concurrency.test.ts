import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReindexDocumentUseCase } from "../../src/application/use-cases/reindex-document.use-case.js";
import { RechunkDocumentUseCase } from "../../src/application/use-cases/rechunk-document.use-case.js";
import { buildIndexProfile } from "../../src/core/index-profile.js";
import { decodeVector } from "../../src/core/vectors.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteVectorStore } from "../../src/infrastructure/sqlite/sqlite-vector-store.js";
import { IndexChangedError, NotFoundError } from "../../src/shared/errors.js";
import { InMemoryFileStorage, makeChunk, makeDocument, Utf8Extractor } from "../support/fakes.js";

let root: string;
let db: ReturnType<typeof openDatabase>;
let other: ReturnType<typeof openDatabase>;
let documents: SqliteDocumentRepository;
let writer: SqliteDocumentRepository;
let vectorStore: SqliteVectorStore;
const profile = buildIndexProfile({ fileName: "a.txt", embeddingModel: "new-model", embeddingDimension: 2, chunkSize: 1000, chunkOverlap: 150 });
const chunk = (id: string, content: string, embedding = [0, 1]) => makeChunk({ id, documentId: "doc", userId: "u", chunkIndex: 0, content, embedding, embeddingModel: "new-model" });

function delayedEmbeddings() {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return { started, release: () => release(), model: "new-model", embedQuery: async () => [1, 0], embedDocuments: async (_texts: string[]) => { entered(); await gate; return [[1, 0]]; } };
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-index-race-"));
  const file = path.join(root, "app.db");
  db = openDatabase(file, { legacyEmbeddingModel: "old-model" });
  other = openDatabase(file, { legacyEmbeddingModel: "old-model" });
  documents = new SqliteDocumentRepository(db);
  writer = new SqliteDocumentRepository(other);
  vectorStore = new SqliteVectorStore(db);
  await documents.saveWithChunks(makeDocument({ id: "doc", userId: "u", fileName: "a.txt", storedName: "original.txt" }), [chunk("original", "cat", [1, 0])]);
});
afterEach(() => { db.close(); other.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function replace() {
  await writer.replaceDocument("u", "doc", { fileName: "b.txt", storedName: "replacement.txt", mimeType: "text/plain", fileSize: 3, textLength: 3, contentHash: "a".repeat(64), indexProfile: profile, chunks: [chunk("replacement", "dog")], updatedAt: "2026-10-05T00:00:00Z" });
}
function stored() {
  const row = db.prepare<[], { content: string; embedding: Buffer }>("SELECT content, embedding FROM document_chunks").get()!;
  return { content: row.content, vector: [...decodeVector(row.embedding)] };
}

describe("index publication across SQLite connections", () => {
  it("rejects old embeddings after equal-count content replacement, preserving the new text, vectors and profile", async () => {
    const embeddings = delayedEmbeddings();
    const pending = new ReindexDocumentUseCase({ documents, vectorStore, embeddings }).execute("u", "doc");
    await embeddings.started;
    await replace();
    embeddings.release();
    await expect(pending).rejects.toBeInstanceOf(IndexChangedError);
    expect(stored()).toEqual({ content: "dog", vector: [0, 1] });
    expect(await documents.findById("u", "doc")).toMatchObject({ documentVersion: 2, indexRevision: 2, indexProfile: profile });
  });

  it("rejects re-embedding when a rechunk changes IDs without changing documentVersion", async () => {
    const embeddings = delayedEmbeddings();
    const pending = new ReindexDocumentUseCase({ documents, vectorStore, embeddings }).execute("u", "doc");
    await embeddings.started;
    await writer.replaceChunks("u", "doc", { chunks: [chunk("rechunked", "new extraction")], indexProfile: profile, textLength: 14 });
    embeddings.release();
    await expect(pending).rejects.toBeInstanceOf(IndexChangedError);
    expect(stored()).toEqual({ content: "new extraction", vector: [0, 1] });
    expect(await documents.findById("u", "doc")).toMatchObject({ documentVersion: 1, indexRevision: 2 });
  });

  it("rejects rechunking prepared from an original that has since been replaced", async () => {
    const embeddings = delayedEmbeddings();
    const files = new InMemoryFileStorage();
    files.files.set("original.txt", Buffer.from("cat"));
    const pending = new RechunkDocumentUseCase({ documents, files, extractor: new Utf8Extractor(), embeddings, options: { chunkSize: 1000, chunkOverlap: 150, maxChunksPerDocument: 100 } }).execute("u", "doc");
    await embeddings.started;
    await replace();
    embeddings.release();
    await expect(pending).rejects.toBeInstanceOf(IndexChangedError);
    expect(stored()).toEqual({ content: "dog", vector: [0, 1] });
  });

  it("rejects competing re-embedding even when chunk IDs and content version are unchanged", async () => {
    const a = delayedEmbeddings(); const b = delayedEmbeddings();
    const first = new ReindexDocumentUseCase({ documents, vectorStore, embeddings: a }).execute("u", "doc");
    const second = new ReindexDocumentUseCase({ documents: writer, vectorStore: new SqliteVectorStore(other), embeddings: b }).execute("u", "doc");
    await Promise.all([a.started, b.started]);
    a.release(); await first;
    b.release(); await expect(second).rejects.toBeInstanceOf(IndexChangedError);
    expect((await documents.findById("u", "doc"))?.indexRevision).toBe(2);
  });

  it("does not resurrect a document deleted during embedding generation", async () => {
    const embeddings = delayedEmbeddings();
    const pending = new ReindexDocumentUseCase({ documents, vectorStore, embeddings }).execute("u", "doc");
    await embeddings.started;
    await writer.delete("u", "doc");
    embeddings.release();
    await expect(pending).rejects.toBeInstanceOf(NotFoundError);
    expect(await documents.readIndexSnapshot("u", "doc")).toBeNull();
  });
});
