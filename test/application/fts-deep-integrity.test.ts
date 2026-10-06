import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { IntegrityStore } from "../../src/application/ports/integrity-store.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { InspectIntegrityUseCase } from "../../src/application/use-cases/inspect-integrity.use-case.js";
import type { IntegrityReport } from "../../src/application/use-cases/inspect-integrity.use-case.js";
import { RepairIntegrityUseCase } from "../../src/application/use-cases/repair-integrity.use-case.js";
import { openDatabase, openDatabaseReadOnly } from "../../src/infrastructure/sqlite/database.js";
import { SqliteIntegrityStore } from "../../src/infrastructure/sqlite/sqlite-integrity-store.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const recipe = { embeddingModel: "test-model", chunkSize: 200, chunkOverlap: 20 };

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;

async function ingest(fileName: string, text: string, userId = "u1") {
  const result = await new IngestDocumentUseCase({
    documents: stores.documents,
    files,
    extractor: new Utf8Extractor(),
    embeddings: new KeywordEmbeddings(),
    options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
  }).execute({ userId, fileName, mimeType: "text/plain", data: Buffer.from(text) });
  return result.documentId;
}

const inspector = (store: IntegrityStore = new SqliteIntegrityStore(stores.db), deepFullText = true) =>
  new InspectIntegrityUseCase({ store, maintenance: stores.maintenance, files, recipe, now: () => NOW, verifyHashes: false, deepFullText });
const repairer = (store: IntegrityStore) =>
  new RepairIntegrityUseCase({ inspect: inspector(store), store, documents: stores.documents, files, now: () => NOW });
const codes = (report: IntegrityReport) => report.issues.map((issue) => issue.code);

/** Edits chunk text without the trigger: the row count stays right, only the content no longer matches the index. */
const editTextBehindTheIndex = (id: string, text: string) => {
  stores.db.exec("DROP TRIGGER chunks_fts_update");
  stores.db.prepare("UPDATE document_chunks SET content = ? WHERE id = ?").run(text, id);
};
const firstChunkId = () => (stores.db.prepare("SELECT id FROM document_chunks ORDER BY seq LIMIT 1").get() as { id: string }).id;

beforeEach(async () => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  files.defaultModifiedAtMs = NOW - 48 * 3600_000;
  await ingest("a.txt", "The cat sleeps on the sofa all afternoon. Tax forms arrive in April. ".repeat(6));
  await ingest("b.txt", "Quarterly reports mention spacecraft launches and orbital mechanics. ".repeat(6), "u2");
});

describe("deep full-text check", () => {
  it("a healthy index passes both the content comparison and the sample searches", async () => {
    const check = await new SqliteIntegrityStore(stores.db).checkFullTextContent();

    expect(check.index).toEqual({ status: "ok" });
    expect(check.probe.checked).toBeGreaterThan(0);
    expect(check.probe).toMatchObject({ missing: 0, leaked: 0 });
    expect(codes(await inspector().execute())).toEqual([]);
  });

  it("detects chunk text that changed without its index entry although the row counts still agree", async () => {
    editTextBehindTheIndex(firstChunkId(), "completely different words about volcanoes");
    const store = new SqliteIntegrityStore(stores.db);

    expect(await store.checkFullText()).toMatchObject({ missing: 0, extra: 0 }); // the cheap check is blind to it
    const report = await inspector().execute();

    expect(codes(report)).toContain("fts-content-mismatch");
    expect(report.issues.find((issue) => issue.code === "fts-content-mismatch")).toMatchObject({ severity: "error", repairable: true, remedy: expect.stringMatching(/--repair/) });
  });

  it("the cheap check alone does not pay for the content comparison", async () => {
    editTextBehindTheIndex(firstChunkId(), "completely different words about volcanoes");

    expect(codes(await inspector(undefined, false).execute())).not.toContain("fts-content-mismatch");
  });

  it("detects the entry of a deleted chunk that is still in the index, and does not report the same fault twice", async () => {
    stores.db.exec("DROP TRIGGER chunks_fts_delete");
    stores.db.prepare("DELETE FROM document_chunks WHERE id = ?").run(firstChunkId());

    const found = codes(await inspector().execute());

    expect(found).toContain("fts-mismatch");
    expect(found).not.toContain("fts-content-mismatch");
  });

  it("the sample searches find a chunk for its owner and never for another user", async () => {
    const store = new SqliteIntegrityStore(stores.db);

    const { probe } = await store.checkFullTextContent({ probeLimit: 1000 });

    expect(probe.checked).toBe((stores.db.prepare("SELECT COUNT(*) AS n FROM document_chunks").get() as { n: number }).n);
    expect(probe.leaked).toBe(0);
  });

  it("reports broken search when an indexed chunk cannot be found by its owner (the index entry points at other words)", async () => {
    // The row counts agree and the entry exists, but it is the entry of different text.
    const id = firstChunkId();
    const seq = (stores.db.prepare("SELECT seq FROM document_chunks WHERE id = ?").get(id) as { seq: number }).seq;
    const old = (stores.db.prepare("SELECT content FROM document_chunks WHERE id = ?").get(id) as { content: string }).content;
    stores.db.prepare("INSERT INTO chunk_fts(chunk_fts, rowid, content) VALUES ('delete', ?, ?)").run(seq, old);
    stores.db.prepare("INSERT INTO chunk_fts(rowid, content) VALUES (?, 'zzzz yyyy')").run(seq);

    const report = await inspector().execute();

    expect(codes(report)).toContain("fts-search-broken");
    expect(report.issues.find((issue) => issue.code === "fts-search-broken")?.message).toMatch(/not found by their owner/);
  });

  it("works on a strictly read-only connection and does not modify the database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-deepfts-"));
    try {
      const file = path.join(directory, "app.db");
      const db = openDatabase(file, { legacyEmbeddingModel: "m" });
      const documents = new SqliteDocumentRepository(db);
      await documents.saveWithChunks(
        { id: "d1", userId: "u1", fileName: "a.txt", storedName: "s", mimeType: "text/plain", fileSize: 1, textLength: 1, summary: null, createdAt: "2026-01-01T00:00:00Z" },
        [{ id: "c1", documentId: "d1", userId: "u1", chunkIndex: 0, content: "readonly check content", embedding: [1], embeddingModel: "m", createdAt: "2026-01-01T00:00:00Z" }],
      );
      db.close();
      const before = fs.readFileSync(file);

      const readOnly = openDatabaseReadOnly(file);
      const check = await new SqliteIntegrityStore(readOnly).checkFullTextContent();
      readOnly.close();

      expect(check.index).toEqual({ status: "ok" });
      expect(check.probe).toEqual({ checked: 1, missing: 0, leaked: 0 });
      expect(fs.readFileSync(file).equals(before)).toBe(true);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("an empty database is healthy", async () => {
    const empty = new SqliteIntegrityStore(createTestStores().db);

    expect(await empty.checkFullTextContent()).toEqual({ index: { status: "ok" }, probe: { checked: 0, missing: 0, leaked: 0 } });
  });
});

describe("rebuild validation", () => {
  it("a content mismatch is repaired by the rebuild, and the repair says what it verified", async () => {
    editTextBehindTheIndex(firstChunkId(), "completely different words about volcanoes");

    const result = await repairer(new SqliteIntegrityStore(stores.db)).execute({});

    expect(result.actions).toContainEqual({
      kind: "rebuilt-full-text-index",
      verified: { chunks: expect.any(Number), searchesChecked: expect.any(Number), contentCheck: "compared" },
    });
    expect(codes(result.after)).toEqual([]);
    expect(await stores.vectorStore.searchLexical({ userId: "u1", query: "volcanoes", limit: 5 })).toHaveLength(1);
  });

  it("fault injection: SQL that 'succeeds' but leaves the index wrong is reported as FAILED, not as a repair", async () => {
    editTextBehindTheIndex(firstChunkId(), "completely different words about volcanoes");
    const real = new SqliteIntegrityStore(stores.db);
    const noOpRebuild: IntegrityStore = Object.create(real, { rebuildFullText: { value: async () => undefined } });

    const result = await repairer(noOpRebuild).execute({});

    expect(result.actions.map((action) => action.kind)).not.toContain("rebuilt-full-text-index");
    expect(result.actions).toContainEqual({
      kind: "failed",
      step: "rebuild full-text index",
      reason: expect.stringMatching(/failed verification.*does not match the chunk text/),
    });
    expect(codes(result.after)).toContain("fts-content-mismatch"); // and the follow-up inspection still sees the problem
  });

  it("fault injection: a rebuild that leaves chunks unindexed is reported as FAILED", async () => {
    stores.db.exec("DROP TRIGGER chunks_fts_insert");
    await ingest("c.txt", "Another document that never reached the index. ".repeat(8));
    const real = new SqliteIntegrityStore(stores.db);
    const noOpRebuild: IntegrityStore = Object.create(real, { rebuildFullText: { value: async () => undefined } });

    const result = await repairer(noOpRebuild).execute({});

    expect(result.actions).toContainEqual({ kind: "failed", step: "rebuild full-text index", reason: expect.stringMatching(/chunks are still not indexed/) });
  });

  it("fault injection: a rebuild whose sample searches still fail is reported as FAILED", async () => {
    stores.db.exec("DROP TRIGGER chunks_fts_insert");
    await ingest("c.txt", "Another document that never reached the index. ".repeat(8));
    const real = new SqliteIntegrityStore(stores.db);
    const lying: IntegrityStore = Object.create(real, {
      rebuildFullText: { value: async () => real.rebuildFullText() },
      checkFullTextContent: { value: async () => ({ index: { status: "ok" as const }, probe: { checked: 10, missing: 3, leaked: 0 } }) },
    });

    const result = await repairer(lying).execute({});

    expect(result.actions).toContainEqual({ kind: "failed", step: "rebuild full-text index", reason: expect.stringMatching(/3 of 10 sampled chunks cannot be found/) });
  });

  it("a rebuild that throws is reported as failed and the other repairs still run", async () => {
    stores.db.exec("DROP TRIGGER chunks_fts_insert");
    await ingest("c.txt", "Another document that never reached the index. ".repeat(8));
    const real = new SqliteIntegrityStore(stores.db);
    const broken: IntegrityStore = Object.create(real, { rebuildFullText: { value: async () => Promise.reject(new Error("database is locked")) } });

    const result = await repairer(broken).execute({});

    expect(result.actions).toContainEqual({ kind: "failed", step: "rebuild full-text index", reason: "database is locked" });
  });
});
