import { beforeEach, describe, expect, it } from "vitest";
import { runStartupCheck } from "../../src/application/startup-check.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { SqliteIntegrityStore } from "../../src/infrastructure/sqlite/sqlite-integrity-store.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const recipe = { embeddingModel: "test-model", chunkSize: 200, chunkOverlap: 20 };

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;
let entries: Array<{ fields: Record<string, unknown>; message: string; level: "info" | "warn" }>;
const log = {
  info: (fields: Record<string, unknown>, message: string) => void entries.push({ fields, message, level: "info" }),
  warn: (fields: Record<string, unknown>, message: string) => void entries.push({ fields, message, level: "warn" }),
};

async function ingest(fileName: string) {
  const result = await new IngestDocumentUseCase({
    documents: stores.documents,
    files,
    extractor: new Utf8Extractor(),
    embeddings: new KeywordEmbeddings(),
    options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
  }).execute({ userId: "u1", fileName, mimeType: "text/plain", data: Buffer.from(`The cat sleeps (${fileName}). `.repeat(10)) });
  return result.documentId;
}

const check = (active = recipe) =>
  runStartupCheck({ store: new SqliteIntegrityStore(stores.db), maintenance: stores.maintenance, files, recipe: active, now: () => NOW, log });

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  files.defaultModifiedAtMs = NOW - 48 * HOUR;
  entries = [];
});

describe("startup check", () => {
  it("logs a quiet summary for a healthy installation", async () => {
    await ingest("a.txt");

    const summary = await check();

    expect(summary).toEqual({ documents: 1, embeddingStale: 0, chunkingStale: 0, extractorStale: 0, missingOriginals: 0, staleTemporaryFiles: 0, orphanFiles: 0 });
    expect(entries.map((entry) => entry.level)).toEqual(["info"]);
    expect(entries[0].fields).toMatchObject({ stage: "startup-check", documents: 1 });
  });

  it("counts stale documents, missing originals, stale temporary files and orphans, and points to the deep check", async () => {
    const stale = await ingest("a.txt");
    const missing = await ingest("b.txt");
    files.files.delete((await stores.documents.findById("u1", missing))!.storedName);
    files.files.set("stray.txt", Buffer.from("x"));
    files.temporary.set(".tmp-1-x.part", { size: 1, modifiedAtMs: NOW - 5 * HOUR });
    files.temporary.set(".tmp-2-y.part", { size: 1, modifiedAtMs: NOW - 1000 }); // maybe still being written: not stale
    void stale;

    const summary = await check({ ...recipe, chunkSize: 500 });

    expect(summary).toMatchObject({ documents: 2, chunkingStale: 2, missingOriginals: 1, staleTemporaryFiles: 1, orphanFiles: 1 });
    const warning = entries.find((entry) => entry.level === "warn" && entry.fields.stage === "startup-check");
    expect(warning?.message).toMatch(/npm run integrity/);
  });

  it("does not repair anything, delete anything or call a provider: it only reads", async () => {
    await ingest("a.txt");
    files.temporary.set(".tmp-1-x.part", { size: 1, modifiedAtMs: NOW - 5 * HOUR });
    files.files.set("stray.txt", Buffer.from("x"));
    const before = { files: [...files.files.keys()], temporary: [...files.temporary.keys()], documents: stores.db.prepare("SELECT COUNT(*) AS n FROM documents").get() };

    await check();

    expect({ files: [...files.files.keys()], temporary: [...files.temporary.keys()], documents: stores.db.prepare("SELECT COUNT(*) AS n FROM documents").get() }).toEqual(before);
  });

  it("never fails the start: a storage that cannot be listed is reported and the rest still works", async () => {
    await ingest("a.txt");
    files.list = async () => {
      throw new Error("EACCES");
    };

    const summary = await check();

    expect(summary.documents).toBe(1);
    expect(entries.some((entry) => entry.level === "warn" && /storage/i.test(entry.message))).toBe(true);
  });
});
