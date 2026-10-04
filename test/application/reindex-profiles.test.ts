import { beforeEach, describe, expect, it } from "vitest";
import { checkIndexCompatibility } from "../../src/application/check-index-compatibility.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { ReindexDocumentUseCase } from "../../src/application/use-cases/reindex-document.use-case.js";
import { RechunkDocumentUseCase } from "../../src/application/use-cases/rechunk-document.use-case.js";
import { RunReindexUseCase } from "../../src/application/use-cases/run-reindex.use-case.js";
import type { ReindexProgress, ReindexRequest } from "../../src/application/use-cases/run-reindex.use-case.js";
import { LEGACY_PDF_EXTRACTOR_VERSION } from "../../src/core/index-profile.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, PAGE_BREAK, Utf8Extractor } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;
let extractor: Utf8Extractor;

const KEYWORDS = ["cat", "dog", "tax", "space"];
const TEXT = "The cat sleeps all day. The dog barks at the cat. Taxes are due in April. ".repeat(10);
const CURRENT = { chunkSize: 200, chunkOverlap: 20 };

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  extractor = new Utf8Extractor();
});

/** Indexes a document with the recipe `{200, 20, test-model}` through the real ingestion pipeline. */
async function ingest(fileName: string, userId = "user-1", text = TEXT) {
  const result = await new IngestDocumentUseCase({
    documents: stores.documents,
    files,
    extractor,
    embeddings: new KeywordEmbeddings(KEYWORDS, "test-model"),
    options: {
      maxUploadBytes: 100_000,
      ...CURRENT,
      maxDocumentsPerUser: 50,
      maxStorageBytesPerUser: 10_000_000,
      maxChunksPerDocument: 500,
    },
  }).execute({ userId, fileName, mimeType: "text/plain", data: Buffer.from(text) });
  return result.documentId;
}

function runner(options: { model?: string; chunkSize?: number; chunkOverlap?: number; keywords?: string[] } = {}) {
  const embeddings = new KeywordEmbeddings(options.keywords ?? KEYWORDS, options.model ?? "test-model");
  const chunking = { chunkSize: options.chunkSize ?? CURRENT.chunkSize, chunkOverlap: options.chunkOverlap ?? CURRENT.chunkOverlap };
  const use = new RunReindexUseCase({
    maintenance: stores.maintenance,
    embeddings,
    chunking,
    reindexDocument: new ReindexDocumentUseCase({ ...stores, embeddings }),
    rechunkDocument: new RechunkDocumentUseCase({
      documents: stores.documents,
      files,
      extractor,
      embeddings,
      options: { ...chunking, maxChunksPerDocument: 500 },
    }),
  });
  return { use, embeddings };
}

const run = (r: ReturnType<typeof runner>, request: Partial<ReindexRequest> = {}) =>
  r.use.execute({ scope: { kind: "stale" }, ...request });

const chunkIds = (documentId: string) =>
  (stores.db.prepare("SELECT id FROM document_chunks WHERE document_id = ? ORDER BY chunk_index").all(documentId) as Array<{ id: string }>).map(
    (row) => row.id,
  );

const staleOf = (report: Awaited<ReturnType<typeof run>>, documentId: string) =>
  report.stale.find((item) => item.documentId === documentId);

describe("stale detection from the index profile", () => {
  it("an unchanged recipe is current: nothing stale, nothing planned", async () => {
    await ingest("a.txt");

    const report = await run(runner(), { dryRun: true });

    expect(report.summary).toEqual({ checked: 1, embedding: 0, chunking: 0, extractor: 0, unknownChunkLayout: 0 });
    expect(report.stale).toEqual([]);
    expect(report.documents).toBe(0);
  });

  it("a different chunk size marks the document chunking-stale, with the old and the new value", async () => {
    const id = await ingest("a.txt");

    const report = await run(runner({ chunkSize: 100 }), { dryRun: true });

    expect(report.summary).toMatchObject({ checked: 1, embedding: 0, chunking: 1, extractor: 0 });
    expect(staleOf(report, id)?.reasons).toEqual([{ kind: "chunking", field: "chunkSize", from: 200, to: 100 }]);
  });

  it("a different overlap marks the document chunking-stale", async () => {
    const id = await ingest("a.txt");

    const report = await run(runner({ chunkOverlap: 50 }), { dryRun: true });

    expect(staleOf(report, id)?.reasons).toEqual([{ kind: "chunking", field: "chunkOverlap", from: 20, to: 50 }]);
  });

  it("a different embedding model marks the document embedding-stale", async () => {
    const id = await ingest("a.txt");

    const report = await run(runner({ model: "new-model" }), { dryRun: true });

    expect(report.summary).toMatchObject({ embedding: 1, chunking: 0, extractor: 0 });
    expect(staleOf(report, id)?.reasons).toEqual([
      { kind: "embedding", field: "embeddingModel", from: "test-model", to: "new-model" },
    ]);
  });

  it("a PDF indexed before pages were tracked is extractor-stale; text documents are not", async () => {
    const pdf = await ingest("old.pdf");
    const txt = await ingest("old.txt");
    stores.db.prepare("UPDATE documents SET index_profile = NULL, index_fingerprint = NULL").run(); // as if indexed by the previous release

    const report = await run(runner(), { dryRun: true });

    expect(staleOf(report, pdf)?.reasons).toEqual([
      { kind: "extractor", field: "extractorVersion", from: LEGACY_PDF_EXTRACTOR_VERSION, to: "pdf-pages-v2" },
    ]);
    expect(staleOf(report, txt)).toBeUndefined();
    expect(report.summary).toMatchObject({ checked: 2, extractor: 1, unknownChunkLayout: 2 });
  });

  it("does not call a legacy document chunking-stale just because its chunk size was never recorded", async () => {
    await ingest("legacy.txt");
    stores.db.prepare("UPDATE documents SET index_profile = NULL").run();

    const report = await run(runner({ chunkSize: 100 }), { dryRun: true });

    expect(report.summary).toMatchObject({ chunking: 0, unknownChunkLayout: 1 });
    expect(report.stale).toEqual([]);
  });

  it("flags unreadable vectors even when the recipe matches", async () => {
    const id = await ingest("a.txt");
    stores.db.prepare("UPDATE document_chunks SET embedding = x'', embedding_dim = 0 WHERE chunk_index = 0").run();

    const report = await run(runner(), { dryRun: true });

    expect(report.summary.embedding).toBe(1);
    expect(staleOf(report, id)?.reasons[0]).toMatchObject({ kind: "embedding", field: "vectors" });
  });

  it("counts every kind separately across documents", async () => {
    await ingest("one.txt"); // current
    const embedStale = await ingest("two.txt");
    const chunkStale = await ingest("three.txt");
    stores.db.prepare("UPDATE document_chunks SET embedding_model = 'old' WHERE document_id = ?").run(embedStale);
    stores.db
      .prepare("UPDATE documents SET index_profile = json_set(index_profile, '$.chunkSize', 999) WHERE id = ?")
      .run(chunkStale);

    const report = await run(runner(), { dryRun: true });

    expect(report.summary).toEqual({ checked: 3, embedding: 1, chunking: 1, extractor: 0, unknownChunkLayout: 0 });
  });
});

describe("dry run", () => {
  it("makes zero embedding calls and changes nothing", async () => {
    const id = await ingest("a.txt");
    const before = chunkIds(id);
    const r = runner({ model: "new-model", chunkSize: 100 });

    const report = await run(r, { dryRun: true });
    await run(r, { dryRun: true, scope: { kind: "all" } });
    await run(r, { dryRun: true, rechunk: true });

    expect(r.embeddings.documentCalls).toEqual([]);
    expect(r.embeddings.queryCalls).toEqual([]); // not even the dimension probe
    expect(report.dryRun).toBe(true);
    expect(chunkIds(id)).toEqual(before);
    expect(files.files.size).toBe(1);
  });

  it("reports why a document is stale and what the run would do about it", async () => {
    const id = await ingest("a.txt");
    const progress: ReindexProgress[] = [];

    await run(runner({ model: "new-model", chunkSize: 100 }), {
      dryRun: true,
      rechunk: true,
      onProgress: (item) => progress.push(item),
    });

    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({ documentId: id, outcome: "planned", action: "rechunk" });
    expect(progress[0].reasons.map((reason) => reason.field)).toEqual(["embeddingModel", "chunkSize"]);
  });
});

describe("re-embed versus re-chunk", () => {
  async function threeDocuments() {
    const current = await ingest("current.txt");
    const embedStale = await ingest("embedding.txt");
    const chunkStale = await ingest("chunking.txt");
    stores.db.prepare("UPDATE document_chunks SET embedding_model = 'old' WHERE document_id = ?").run(embedStale);
    stores.db
      .prepare("UPDATE documents SET index_profile = json_set(index_profile, '$.chunkSize', 999) WHERE id = ?")
      .run(chunkStale);
    return { current, embedStale, chunkStale };
  }

  it("by default only embedding-stale documents are re-embedded, keeping their chunks; chunk-stale ones are reported, not touched", async () => {
    const { current, embedStale, chunkStale } = await threeDocuments();
    const before = { current: chunkIds(current), embedStale: chunkIds(embedStale), chunkStale: chunkIds(chunkStale) };

    const report = await run(runner());

    expect(report).toMatchObject({ documents: 1, succeeded: 1, failed: [], reembedded: 1, rechunked: 0 });
    expect(chunkIds(embedStale)).toEqual(before.embedStale); // same chunks, new vectors
    expect(chunkIds(current)).toEqual(before.current);
    expect(chunkIds(chunkStale)).toEqual(before.chunkStale);
    expect(staleOf(report, chunkStale)).toMatchObject({ action: null }); // needs --rechunk
    expect(
      (stores.db.prepare("SELECT DISTINCT embedding_model AS m FROM document_chunks WHERE document_id = ?").get(embedStale) as { m: string }).m,
    ).toBe("test-model");
  });

  it("--rechunk re-chunks the chunk-stale documents and merely re-embeds the embedding-stale ones", async () => {
    const { current, embedStale, chunkStale } = await threeDocuments();
    const before = { current: chunkIds(current), embedStale: chunkIds(embedStale), chunkStale: chunkIds(chunkStale) };

    const report = await run(runner(), { rechunk: true });

    expect(report).toMatchObject({ documents: 2, succeeded: 2, reembedded: 1, rechunked: 1 });
    expect(chunkIds(embedStale)).toEqual(before.embedStale);
    expect(chunkIds(current)).toEqual(before.current);
    expect(chunkIds(chunkStale)).not.toEqual(before.chunkStale);

    const after = await run(runner(), { dryRun: true });
    expect(after.summary).toMatchObject({ embedding: 0, chunking: 0, extractor: 0 });
  });

  it("--all --rechunk rebuilds every document from its original file", async () => {
    const a = await ingest("a.txt");
    const b = await ingest("b.txt", "user-2");
    const before = [...chunkIds(a), ...chunkIds(b)];

    const report = await run(runner(), { scope: { kind: "all" }, rechunk: true });

    expect(report).toMatchObject({ documents: 2, succeeded: 2, rechunked: 2, reembedded: 0 });
    expect([...chunkIds(a), ...chunkIds(b)].some((id) => before.includes(id))).toBe(false);
  });

  it("re-chunking applies a new chunk size, after which the document is current", async () => {
    const id = await ingest("a.txt");
    const small = runner({ chunkSize: 100, chunkOverlap: 10 });
    expect((await run(small, { dryRun: true })).summary.chunking).toBe(1);

    await run(small, { rechunk: true });

    expect((await run(small, { dryRun: true })).summary).toMatchObject({ embedding: 0, chunking: 0 });
    expect(chunkIds(id).length).toBeGreaterThan(TEXT.length / 200);
  });

  it("a PDF indexed without pages gains page provenance with --rechunk", async () => {
    const id = await ingest("old.pdf", "user-1", ["Cats sleep. ".repeat(20), "Dogs bark. ".repeat(20)].join(PAGE_BREAK));
    stores.db.prepare("UPDATE documents SET index_profile = NULL").run();
    stores.db.prepare("UPDATE document_chunks SET page_start = NULL, page_end = NULL").run();

    const report = await run(runner(), { rechunk: true });

    expect(report).toMatchObject({ rechunked: 1 });
    const rows = stores.db.prepare("SELECT page_start AS s FROM document_chunks WHERE document_id = ?").all(id) as Array<{ s: number | null }>;
    expect(rows.every((row) => row.s !== null)).toBe(true);
  });

  it("a failing document keeps its old index and does not stop the others", async () => {
    const good = await ingest("good.txt");
    const bad = await ingest("bad.txt");
    const badBefore = chunkIds(bad);
    files.failOnRead = false;
    const original = files.read.bind(files);
    files.read = async (name) => {
      if (name.includes("bad")) throw new Error("file vanished");
      return original(name);
    };

    const report = await run(runner({ chunkSize: 100 }), { rechunk: true });

    expect(report).toMatchObject({ succeeded: 1, rechunked: 1 });
    expect(report.failed).toEqual([{ documentId: bad, fileName: "bad.txt", reason: expect.stringContaining("file vanished") }]);
    expect(chunkIds(bad)).toEqual(badBefore);
    expect(chunkIds(good)).not.toEqual([]);
  });
});

describe("startup diagnostic", () => {
  it("reports embedding, chunking and extractor staleness separately and names the commands", async () => {
    await ingest("a.txt");
    const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];

    const summary = await checkIndexCompatibility(
      stores.maintenance,
      { embeddingModel: "new-model", chunkSize: 100, chunkOverlap: 20 },
      { warn: (fields: Record<string, unknown>, message: string) => void warnings.push({ fields, message }) },
    );

    expect(summary).toMatchObject({ staleDocuments: 1, chunkingStale: 1, embeddingStale: 1, extractorStale: 0 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("npm run reindex");
    expect(warnings[0].message).toContain("--rechunk");
  });
});
