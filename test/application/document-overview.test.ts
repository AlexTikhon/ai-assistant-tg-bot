import { beforeEach, describe, expect, it } from "vitest";
import { GetDocumentUseCase } from "../../src/application/use-cases/get-document.use-case.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { ListDocumentsUseCase } from "../../src/application/use-cases/list-documents.use-case.js";
import { NotFoundError } from "../../src/shared/errors.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;

const recipe = { embeddingModel: "test-model", chunkSize: 200, chunkOverlap: 20 };

async function ingest(userId: string, fileName: string, text: string) {
  const result = await new IngestDocumentUseCase({
    documents: stores.documents,
    files,
    extractor: new Utf8Extractor(),
    embeddings: new KeywordEmbeddings(),
    options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
  }).execute({ userId, fileName, mimeType: "text/plain", data: Buffer.from(text) });
  return result.documentId;
}

const list = (userId: string, active = recipe) =>
  new ListDocumentsUseCase({ documents: stores.documents, maintenance: stores.maintenance, files, recipe: active }).execute(userId);
const get = (userId: string, documentId: string, active = recipe) =>
  new GetDocumentUseCase({ documents: stores.documents, maintenance: stores.maintenance, files, recipe: active }).execute(userId, documentId);

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
});

describe("ListDocumentsUseCase", () => {
  it("lists the user's documents with their health, newest first, and no one else's", async () => {
    const first = await ingest("u1", "a.txt", "cat story. ".repeat(30));
    await ingest("u2", "other.txt", "dog story. ".repeat(30));
    const second = await ingest("u1", "b.txt", "tax story. ".repeat(30));
    stores.db.prepare("UPDATE documents SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(first);

    const overview = await list("u1");

    expect(overview.map((item) => [item.document.id, item.health.state])).toEqual([
      [second, "current"],
      [first, "current"],
    ]);
  });

  it("shows a stale index and a missing original per document", async () => {
    const stale = await ingest("u1", "a.txt", "cat story. ".repeat(30));
    const missing = await ingest("u1", "b.txt", "tax story. ".repeat(30));
    const missingFile = (await stores.documents.findById("u1", missing))!.storedName;
    files.files.delete(missingFile);

    const overview = await list("u1", { ...recipe, chunkSize: 500 });
    const states = Object.fromEntries(overview.map((item) => [item.document.id, item.health.issues]));

    expect(states[stale]).toEqual(["chunking-stale"]);
    expect(states[missing]).toEqual(["chunking-stale", "missing-file"]);
  });

  it("does not fail when the storage cannot be inspected: the file state is simply not reported", async () => {
    const id = await ingest("u1", "a.txt", "cat story. ".repeat(30));
    files.stat = async () => {
      throw new Error("EIO");
    };

    expect((await list("u1"))[0]).toMatchObject({ document: { id }, health: { state: "current" } });
  });
});

describe("GetDocumentUseCase", () => {
  it("describes one document with its chunk count and health", async () => {
    const id = await ingest("u1", "a.txt", "cat story. ".repeat(30));

    const info = await get("u1", id);

    expect(info.document).toMatchObject({ id, fileName: "a.txt", documentVersion: 1 });
    expect(info.chunksCount).toBeGreaterThan(0);
    expect(info.health.state).toBe("current");
  });

  it("is ownership scoped: another user's document looks exactly like a missing one", async () => {
    const id = await ingest("owner", "a.txt", "cat story. ".repeat(30));

    await expect(get("intruder", id)).rejects.toThrow(NotFoundError);
    await expect(get("owner", "no-such-id")).rejects.toThrow(NotFoundError);
  });
});
