import { beforeEach, describe, expect, it } from "vitest";
import type { DocumentRepository } from "../../src/application/ports/document-repository.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { RechunkDocumentUseCase } from "../../src/application/use-cases/rechunk-document.use-case.js";
import { buildIndexProfile } from "../../src/core/index-profile.js";
import { NotFoundError, ValidationError } from "../../src/shared/errors.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, PAGE_BREAK, Utf8Extractor } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;
let extractor: Utf8Extractor;
let embeddings: KeywordEmbeddings;

const ingestOptions = {
  maxUploadBytes: 100_000,
  chunkSize: 200,
  chunkOverlap: 20,
  maxDocumentsPerUser: 10,
  maxStorageBytesPerUser: 1_000_000,
  maxChunksPerDocument: 100,
};

const TEXT = "The cat sleeps all day. The dog barks at the cat. Taxes are due in April. ".repeat(12);

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  extractor = new Utf8Extractor();
  embeddings = new KeywordEmbeddings();
});

async function ingest(fileName = "pets.txt", text = TEXT, userId = "user-1") {
  const result = await new IngestDocumentUseCase({
    documents: stores.documents,
    files,
    extractor,
    embeddings,
    options: ingestOptions,
  }).execute({ userId, fileName, mimeType: "text/plain", data: Buffer.from(text) });
  return result.documentId;
}

function createRechunk(overrides: { documents?: DocumentRepository; maxChunksPerDocument?: number; chunkSize?: number } = {}) {
  return new RechunkDocumentUseCase({
    documents: overrides.documents ?? stores.documents,
    files,
    extractor,
    embeddings,
    options: {
      chunkSize: overrides.chunkSize ?? 100,
      chunkOverlap: 10,
      maxChunksPerDocument: overrides.maxChunksPerDocument ?? 500,
    },
  });
}

const chunkRows = () =>
  stores.db
    .prepare("SELECT id, chunk_index AS i, content, embedding_model AS m FROM document_chunks ORDER BY document_id, chunk_index")
    .all() as Array<{ id: string; i: number; content: string; m: string }>;

const profileOf = async (documentId: string, userId = "user-1") =>
  (await stores.documents.findById(userId, documentId))?.indexProfile;

async function snapshot(documentId: string) {
  return {
    chunks: chunkRows(),
    document: await stores.documents.findById("user-1", documentId),
    files: new Map(files.files),
    ftsRows: (stores.db.prepare("SELECT COUNT(*) AS n FROM chunk_fts").get() as { n: number }).n,
  };
}

describe("RechunkDocumentUseCase: success", () => {
  it("re-extracts the stored original, splits it with the current settings and replaces the chunks", async () => {
    const documentId = await ingest();
    const before = chunkRows();

    const result = await createRechunk().execute("user-1", documentId);

    const after = chunkRows();
    expect(result.chunksCount).toBe(after.length);
    expect(after.length).toBeGreaterThan(before.length); // smaller chunks -> more of them
    expect(Math.max(...after.map((row) => row.content.length))).toBeLessThanOrEqual(100);
    expect(after.some((row) => before.some((old) => old.id === row.id))).toBe(false);
    expect(await profileOf(documentId)).toEqual(
      buildIndexProfile({
        fileName: "pets.txt",
        embeddingModel: "test-model",
        embeddingDimension: 4,
        chunkSize: 100,
        chunkOverlap: 10,
      }),
    );
  });

  it("keeps the document, its owner, its summary and the original file exactly as they were", async () => {
    const documentId = await ingest();
    await stores.documents.updateSummary("user-1", documentId, "cached summary");
    const before = await snapshot(documentId);

    await createRechunk().execute("user-1", documentId);

    const after = await snapshot(documentId);
    expect(after.files).toEqual(before.files);
    expect(after.document).toMatchObject({
      id: documentId,
      userId: "user-1",
      fileName: "pets.txt",
      storedName: before.document?.storedName,
      summary: "cached summary",
    });
  });

  it("updates the full-text index to the new chunks and removes the old ones", async () => {
    const documentId = await ingest();
    const oldIds = new Set(chunkRows().map((row) => row.id));

    await createRechunk().execute("user-1", documentId);

    const hits = await stores.vectorStore.searchLexical({ userId: "user-1", query: "taxes april", limit: 50 });
    const newIds = new Set(chunkRows().map((row) => row.id));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit) => newIds.has(hit.chunkId) && !oldIds.has(hit.chunkId))).toBe(true);
    expect((stores.db.prepare("SELECT COUNT(*) AS n FROM chunk_fts").get() as { n: number }).n).toBe(newIds.size);
  });

  it("embeds the new chunks with the configured model and makes them searchable semantically", async () => {
    const documentId = await ingest();

    await createRechunk().execute("user-1", documentId);

    expect(new Set(chunkRows().map((row) => row.m))).toEqual(new Set(["test-model"]));
    const matches = await stores.vectorStore.searchSimilar({
      userId: "user-1",
      embedding: [1, 0, 0, 0],
      embeddingModel: "test-model",
      limit: 3,
      minScore: 0.2,
    });
    expect(matches.length).toBeGreaterThan(0);
  });

  it("adds page provenance to a PDF that was indexed without it", async () => {
    const pages = ["Cats sleep. ".repeat(10), "Dogs bark. ".repeat(10)].join(PAGE_BREAK);
    const documentId = await ingest("old.pdf", pages);
    stores.db.prepare("UPDATE document_chunks SET page_start = NULL, page_end = NULL").run(); // as if indexed before pages

    await createRechunk().execute("user-1", documentId);

    const rows = stores.db.prepare("SELECT page_start AS s, page_end AS e FROM document_chunks").all() as Array<{
      s: number | null;
      e: number | null;
    }>;
    expect(rows.every((row) => row.s !== null && row.e !== null)).toBe(true);
    expect(rows[0].s).toBe(1);
    expect(rows[rows.length - 1].e).toBe(2);
  });

  it("only touches the document it was asked for, and never one of another user", async () => {
    const mine = await ingest("mine.txt", TEXT, "user-1");
    const theirs = await ingest("theirs.txt", TEXT, "user-2");
    const theirsBefore = stores.db.prepare("SELECT id FROM document_chunks WHERE document_id = ?").all(theirs);

    await createRechunk().execute("user-1", mine);
    await expect(createRechunk().execute("user-1", theirs)).rejects.toThrow(NotFoundError);

    expect(stores.db.prepare("SELECT id FROM document_chunks WHERE document_id = ?").all(theirs)).toEqual(theirsBefore);
  });
});

describe("RechunkDocumentUseCase: a failure leaves the previous index fully intact", () => {
  async function expectUntouched(documentId: string, run: () => Promise<unknown>, error: RegExp | (new (...args: never[]) => Error)) {
    const before = await snapshot(documentId);

    await expect(run()).rejects.toThrow(error);

    const after = await snapshot(documentId);
    expect(after.chunks).toEqual(before.chunks);
    expect(after.document).toEqual(before.document);
    expect(after.files).toEqual(before.files);
    expect(after.ftsRows).toBe(before.ftsRows);
    const hits = await stores.vectorStore.searchLexical({ userId: "user-1", query: "sleeps", limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
  }

  it("when the original file cannot be read", async () => {
    const documentId = await ingest();
    files.failOnRead = true;

    await expectUntouched(documentId, () => createRechunk().execute("user-1", documentId), /cannot read/);
  });

  it("when text extraction fails", async () => {
    const documentId = await ingest();
    extractor.failWith = new ValidationError("Could not read the PDF.");

    await expectUntouched(documentId, () => createRechunk().execute("user-1", documentId), ValidationError);
  });

  it("when the embeddings provider fails - before anything in the database is touched", async () => {
    const documentId = await ingest();
    embeddings.failWith = new Error("rate limited");

    await expectUntouched(documentId, () => createRechunk().execute("user-1", documentId), /rate limited/);
  });

  it("when the provider returns the wrong number of vectors", async () => {
    const documentId = await ingest();
    embeddings.documentVectorsOverride = [[1, 0, 0, 0]];

    await expectUntouched(documentId, () => createRechunk().execute("user-1", documentId), /AI service/);
  });

  it("when the new layout would exceed the chunk limit", async () => {
    const documentId = await ingest();

    await expectUntouched(
      documentId,
      () => createRechunk({ maxChunksPerDocument: 3 }).execute("user-1", documentId),
      /too large to index/,
    );
    expect(embeddings.documentCalls).toHaveLength(1); // only the original ingestion paid for embeddings
  });

  it("when the database swap fails halfway (rolled back, not half-applied)", async () => {
    const documentId = await ingest();
    // A real failure inside the transaction, after the old chunks were deleted and while inserting new ones.
    stores.db.exec(`
      CREATE TRIGGER fail_insert BEFORE INSERT ON document_chunks
      WHEN new.chunk_index = 2 BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;
    `);

    await expectUntouched(documentId, () => createRechunk().execute("user-1", documentId), /disk on fire/);
  });

  it("does not delete the old chunks before the new ones are ready (call order)", async () => {
    const documentId = await ingest();
    const events: string[] = [];
    const original = embeddings.embedDocuments.bind(embeddings);
    embeddings.embedDocuments = async (texts) => {
      events.push(`embed (old chunks present: ${chunkRows().length > 0})`);
      return original(texts);
    };
    const documents: DocumentRepository = Object.assign(Object.create(stores.documents) as DocumentRepository, {
      replaceChunks: async (...args: Parameters<DocumentRepository["replaceChunks"]>) => {
        events.push("replace");
        return stores.documents.replaceChunks(...args);
      },
    });

    await createRechunk({ documents }).execute("user-1", documentId);

    expect(events).toEqual(["embed (old chunks present: true)", "replace"]);
  });

  it("reports an unknown document as not found", async () => {
    await expect(createRechunk().execute("user-1", "missing")).rejects.toThrow(NotFoundError);
  });
});
