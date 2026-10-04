import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildIndexProfile,
  CHUNKING_ALGORITHM_VERSION,
  indexFingerprint,
  LEGACY_PDF_EXTRACTOR_VERSION,
  TEXT_EXTRACTOR_VERSION,
} from "../../src/core/index-profile.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { SqliteIndexMaintenance } from "../../src/infrastructure/sqlite/sqlite-index-maintenance.js";
import { SqliteVectorStore } from "../../src/infrastructure/sqlite/sqlite-vector-store.js";
import { createTestStores, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;

beforeEach(() => {
  stores = createTestStores();
});

const profile = (overrides: Partial<Parameters<typeof buildIndexProfile>[0]> = {}) =>
  buildIndexProfile({
    fileName: "notes.md",
    embeddingModel: "test-model",
    embeddingDimension: 4,
    chunkSize: 1000,
    chunkOverlap: 150,
    ...overrides,
  });

function chunksOf(documentId: string, texts: string[], extra: Partial<ReturnType<typeof makeChunk>> = {}) {
  return texts.map((content, chunkIndex) =>
    makeChunk({ id: `${documentId}-${chunkIndex}-${content.length}`, documentId, chunkIndex, content, ...extra }),
  );
}

const lexicalIds = async (query: string) =>
  (await stores.vectorStore.searchLexical({ userId: "user-1", query, limit: 10 })).map((match) => match.chunkId);

describe("index profile persistence", () => {
  it("stores the profile with the document and returns it", async () => {
    const recorded = profile();
    await stores.documents.saveWithChunks(
      makeDocument({ id: "doc-1", indexProfile: recorded }),
      chunksOf("doc-1", ["alpha"]),
    );

    expect((await stores.documents.findById("user-1", "doc-1"))?.indexProfile).toEqual(recorded);
    expect(stores.db.prepare("SELECT index_fingerprint AS f FROM documents").get()).toEqual({
      f: indexFingerprint(recorded),
    });
  });

  it("reports a document saved without a profile as unrecorded", async () => {
    await stores.documents.saveWithChunks(makeDocument({ id: "doc-1" }), chunksOf("doc-1", ["alpha"]));

    expect((await stores.documents.findById("user-1", "doc-1"))?.indexProfile).toBeNull();
  });

  it("persists page provenance per chunk and returns it with the chunk text", async () => {
    await stores.documents.saveWithChunks(makeDocument({ id: "doc-1", fileName: "a.pdf" }), [
      makeChunk({ id: "p", documentId: "doc-1", chunkIndex: 0, content: "paged", pageStart: 8, pageEnd: 9 }),
      makeChunk({ id: "t", documentId: "doc-1", chunkIndex: 1, content: "unpaged" }),
    ]);

    const [paged, unpaged] = await stores.vectorStore.getChunks("user-1", ["p", "t"]);

    expect(paged).toMatchObject({ chunkId: "p", pageStart: 8, pageEnd: 9 });
    expect(unpaged.chunkId).toBe("t");
    expect(unpaged.pageStart).toBeUndefined();
    expect(unpaged.pageEnd).toBeUndefined();
  });
});

describe("SqliteDocumentRepository.replaceChunks", () => {
  async function seed() {
    await stores.documents.saveWithChunks(
      makeDocument({ id: "doc-1", indexProfile: profile({ chunkSize: 1200 }) }),
      chunksOf("doc-1", ["old alpha text", "old beta text"]),
    );
  }

  it("swaps chunks, profile and text length in one step and updates the full-text index", async () => {
    await seed();
    const replacement = profile({ chunkSize: 900 });

    await stores.documents.replaceChunks("user-1", "doc-1", {
      chunks: chunksOf("doc-1", ["brand new gamma"], { pageStart: 2, pageEnd: 3 }),
      indexProfile: replacement,
      textLength: 15,
    });

    expect(await stores.vectorStore.listByDocument("user-1", "doc-1")).toEqual([
      { chunkIndex: 0, content: "brand new gamma" },
    ]);
    expect(await lexicalIds("gamma")).toHaveLength(1);
    expect(await lexicalIds("alpha")).toEqual([]); // the old text is gone from the FTS index
    const document = await stores.documents.findById("user-1", "doc-1");
    expect(document).toMatchObject({ textLength: 15, indexProfile: replacement });
  });

  it("keeps the document's id, owner, file reference and summary", async () => {
    await seed();
    await stores.documents.updateSummary("user-1", "doc-1", "kept summary");
    const before = await stores.documents.findById("user-1", "doc-1");

    await stores.documents.replaceChunks("user-1", "doc-1", {
      chunks: chunksOf("doc-1", ["new"]),
      indexProfile: profile(),
      textLength: 3,
    });

    expect(await stores.documents.findById("user-1", "doc-1")).toMatchObject({
      id: "doc-1",
      userId: "user-1",
      storedName: before?.storedName,
      fileName: before?.fileName,
      summary: "kept summary",
    });
  });

  it("rolls everything back when the replacement fails midway", async () => {
    await seed();
    const duplicateIndex = [
      makeChunk({ id: "n0", documentId: "doc-1", chunkIndex: 0, content: "partial new text" }),
      makeChunk({ id: "n1", documentId: "doc-1", chunkIndex: 0, content: "duplicate position" }),
    ];

    await expect(
      stores.documents.replaceChunks("user-1", "doc-1", {
        chunks: duplicateIndex,
        indexProfile: profile({ chunkSize: 500 }),
        textLength: 1,
      }),
    ).rejects.toThrow();

    expect((await stores.vectorStore.listByDocument("user-1", "doc-1")).map((chunk) => chunk.content)).toEqual([
      "old alpha text",
      "old beta text",
    ]);
    expect(await lexicalIds("alpha")).toHaveLength(1);
    expect(await lexicalIds("partial")).toEqual([]);
    expect((await stores.documents.findById("user-1", "doc-1"))?.indexProfile).toEqual(profile({ chunkSize: 1200 }));
  });

  it("refuses documents of other users or that no longer exist, changing nothing", async () => {
    await seed();
    const update = { chunks: chunksOf("doc-1", ["x"]), indexProfile: profile(), textLength: 1 };

    await expect(stores.documents.replaceChunks("user-2", "doc-1", update)).rejects.toThrow(/not found/i);
    await expect(stores.documents.replaceChunks("user-1", "missing", update)).rejects.toThrow(/not found/i);
    expect((await stores.vectorStore.listByDocument("user-1", "doc-1")).length).toBe(2);
  });
});

describe("SqliteVectorStore.replaceEmbeddings with a profile", () => {
  it("updates the vectors and the recorded profile together", async () => {
    await stores.documents.saveWithChunks(
      makeDocument({ id: "doc-1", indexProfile: profile() }),
      chunksOf("doc-1", ["a", "b"]),
    );
    const upgraded = profile({ embeddingModel: "bigger-model", embeddingDimension: 2 });

    await stores.vectorStore.replaceEmbeddings(
      "user-1",
      "doc-1",
      "bigger-model",
      [
        { chunkIndex: 0, embedding: [1, 0] },
        { chunkIndex: 1, embedding: [0, 1] },
      ],
      upgraded,
    );

    expect((await stores.documents.findById("user-1", "doc-1"))?.indexProfile).toEqual(upgraded);
  });

  it("leaves the recorded profile alone when the swap fails", async () => {
    await stores.documents.saveWithChunks(
      makeDocument({ id: "doc-1", indexProfile: profile() }),
      chunksOf("doc-1", ["a", "b"]),
    );

    await expect(
      stores.vectorStore.replaceEmbeddings(
        "user-1",
        "doc-1",
        "bigger-model",
        [{ chunkIndex: 0, embedding: [1, 0] }],
        profile({ embeddingModel: "bigger-model" }),
      ),
    ).rejects.toThrow();

    expect((await stores.documents.findById("user-1", "doc-1"))?.indexProfile).toEqual(profile());
  });
});

describe("SqliteIndexMaintenance profiles", () => {
  const target = { model: "test-model" };

  it("returns the recorded recipe, with the embedding fields taken from the vectors that search uses", async () => {
    await stores.documents.saveWithChunks(
      makeDocument({ id: "doc-1", indexProfile: profile({ chunkSize: 900, chunkOverlap: 90 }) }),
      chunksOf("doc-1", ["a"]),
    );

    const [document] = await stores.maintenance.listIndexedDocuments(target);

    expect(document.storedProfile).toEqual(profile({ chunkSize: 900, chunkOverlap: 90 }));
  });

  it("describes unrecorded (legacy) documents honestly: embedding from the chunks, chunk layout unknown", async () => {
    await stores.documents.saveWithChunks(makeDocument({ id: "txt", fileName: "a.txt" }), chunksOf("txt", ["a"]));
    await stores.documents.saveWithChunks(makeDocument({ id: "pdf", fileName: "b.PDF" }), chunksOf("pdf", ["b"]));

    const documents = await stores.maintenance.listIndexedDocuments(target);
    const byId = Object.fromEntries(documents.map((document) => [document.documentId, document.storedProfile]));

    expect(byId.txt).toEqual({
      embeddingModel: "test-model",
      embeddingDimension: 4,
      chunkSize: null,
      chunkOverlap: null,
      chunkingVersion: CHUNKING_ALGORITHM_VERSION,
      extractorVersion: TEXT_EXTRACTOR_VERSION,
    });
    expect(byId.pdf.extractorVersion).toBe(LEGACY_PDF_EXTRACTOR_VERSION);
  });

  it("ignores a corrupted stored profile instead of failing the whole listing", async () => {
    await stores.documents.saveWithChunks(makeDocument({ id: "doc-1" }), chunksOf("doc-1", ["a"]));
    stores.db.prepare("UPDATE documents SET index_profile = '{not json'").run();

    const [document] = await stores.maintenance.listIndexedDocuments(target);

    expect(document.storedProfile.chunkSize).toBeNull();
  });
});

describe("migration to schema v5", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-v5-"));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("adds the columns to an existing database without touching its data", async () => {
    const dbPath = path.join(directory, "app.db");
    // A database as the previous release left it (schema version 4): create it with the real migrations,
    // then roll the new columns and the version back.
    const first = openDatabase(dbPath, { legacyEmbeddingModel: "m" });
    first.exec(`
      INSERT INTO documents (id, user_id, file_name, stored_name, mime_type, file_size, text_length, summary, created_at)
        VALUES ('d1','u1','old.pdf','s-old.pdf','application/pdf',10,10,NULL,'2025-01-01T00:00:00Z');
      INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at)
        VALUES ('c1','d1','u1',0,'legacy text',x'0000803f','m',1,'2025-01-01T00:00:00Z');
    `);
    first.exec(`
      DROP INDEX idx_documents_user_hash;
      ALTER TABLE documents DROP COLUMN content_hash;
      ALTER TABLE documents DROP COLUMN document_version;
      ALTER TABLE documents DROP COLUMN updated_at;
      ALTER TABLE documents DROP COLUMN previous_content_hash;
      ALTER TABLE documents DROP COLUMN index_profile;
      ALTER TABLE documents DROP COLUMN index_fingerprint;
      ALTER TABLE document_chunks DROP COLUMN page_start;
      ALTER TABLE document_chunks DROP COLUMN page_end;
      ALTER TABLE document_chunks DROP COLUMN section_path;
      ALTER TABLE document_chunks DROP COLUMN page_label_start;
      ALTER TABLE document_chunks DROP COLUMN page_label_end;
      PRAGMA user_version = 4;
    `);
    first.close();

    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });

    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(5);
    expect(db.prepare("SELECT content FROM document_chunks").all()).toEqual([{ content: "legacy text" }]);
    expect(db.prepare("SELECT index_profile AS p, index_fingerprint AS f FROM documents").get()).toEqual({
      p: null,
      f: null,
    });
    expect(db.prepare("SELECT page_start AS s, page_end AS e FROM document_chunks").get()).toEqual({ s: null, e: null });
    // The full-text index still works after the table was altered.
    const matches = await new SqliteVectorStore(db).searchLexical({ userId: "u1", query: "legacy", limit: 5 });
    expect(matches.map((match) => match.chunkId)).toEqual(["c1"]);
    const [document] = await new SqliteIndexMaintenance(db).listIndexedDocuments({ model: "m" });
    expect(document.storedProfile).toMatchObject({ chunkSize: null, extractorVersion: LEGACY_PDF_EXTRACTOR_VERSION });
    db.close();
  });
});

describe("native database sanity", () => {
  it("the SQLite build supports DROP COLUMN (used by the migration test above)", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (a, b); ALTER TABLE t DROP COLUMN b;");
    expect(db.prepare("PRAGMA table_info(t)").all()).toHaveLength(1);
    db.close();
  });
});

describe("migration to schema v6: section paths and page labels", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-v6-"));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("adds the optional provenance columns to an existing database without touching its data", async () => {
    const dbPath = path.join(directory, "app.db");
    const first = openDatabase(dbPath, { legacyEmbeddingModel: "m" });
    first.exec(`
      INSERT INTO documents (id, user_id, file_name, stored_name, mime_type, file_size, text_length, summary, created_at)
        VALUES ('d1','u1','old.md','s-old.md','text/markdown',10,10,NULL,'2025-01-01T00:00:00Z');
      INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, page_start, page_end, created_at)
        VALUES ('c1','d1','u1',0,'legacy text',x'0000803f','m',1,3,4,'2025-01-01T00:00:00Z');
    `);
    first.exec(`
      DROP INDEX idx_documents_user_hash;
      ALTER TABLE documents DROP COLUMN content_hash;
      ALTER TABLE documents DROP COLUMN document_version;
      ALTER TABLE documents DROP COLUMN updated_at;
      ALTER TABLE documents DROP COLUMN previous_content_hash;
      ALTER TABLE document_chunks DROP COLUMN section_path;
      ALTER TABLE document_chunks DROP COLUMN page_label_start;
      ALTER TABLE document_chunks DROP COLUMN page_label_end;
      PRAGMA user_version = 5;
    `);
    first.close();

    const db = openDatabase(dbPath, { legacyEmbeddingModel: "m" });

    expect(db.pragma("user_version", { simple: true })).toBeGreaterThanOrEqual(6);
    expect(db.prepare("SELECT section_path AS s, page_label_start AS a, page_label_end AS b FROM document_chunks").get()).toEqual({
      s: null,
      a: null,
      b: null,
    });
    // An old chunk reads back exactly as before: pages kept, no invented section or labels.
    const [chunk] = await new SqliteVectorStore(db).getChunks("u1", ["c1"]);
    expect(chunk).toMatchObject({ content: "legacy text", pageStart: 3, pageEnd: 4 });
    expect(chunk).not.toHaveProperty("sectionPath");
    expect(chunk).not.toHaveProperty("pageLabelStart");
    db.close();
  });
});

describe("chunk provenance in the store", () => {
  it("round-trips a section path and page labels, and returns nothing for chunks without them", async () => {
    const { documents, vectorStore } = createTestStores();
    await documents.saveWithChunks(makeDocument({ id: "doc-1", fileName: "api.md" }), [
      makeChunk({ id: "with", chunkIndex: 0, sectionPath: ["Authentication", "Refresh tokens"], content: "a" }),
      makeChunk({ id: "labelled", chunkIndex: 1, pageStart: 5, pageEnd: 6, pageLabelStart: "iii", pageLabelEnd: "iv", content: "b" }),
      makeChunk({ id: "plain", chunkIndex: 2, content: "c" }),
    ]);

    const byId = new Map((await vectorStore.getChunks("user-1", ["with", "labelled", "plain"])).map((chunk) => [chunk.chunkId, chunk]));

    expect(byId.get("with")?.sectionPath).toEqual(["Authentication", "Refresh tokens"]);
    expect(byId.get("labelled")).toMatchObject({ pageStart: 5, pageEnd: 6, pageLabelStart: "iii", pageLabelEnd: "iv" });
    expect(byId.get("plain")).not.toHaveProperty("sectionPath");
    expect(byId.get("plain")).not.toHaveProperty("pageLabelStart");
  });

  it("treats an unreadable stored section path as unknown instead of failing the search", async () => {
    const { db, documents, vectorStore } = createTestStores();
    await documents.saveWithChunks(makeDocument({ id: "doc-1" }), [makeChunk({ id: "c1", content: "a" })]);
    db.prepare("UPDATE document_chunks SET section_path = '{not json'").run();

    const [chunk] = await vectorStore.getChunks("user-1", ["c1"]);

    expect(chunk.content).toBe("a");
    expect(chunk).not.toHaveProperty("sectionPath");
  });

  it("does not return a section path that is not a list of strings", async () => {
    const { db, documents, vectorStore } = createTestStores();
    await documents.saveWithChunks(makeDocument({ id: "doc-1" }), [makeChunk({ id: "c1", content: "a" })]);
    db.prepare("UPDATE document_chunks SET section_path = '[1,2]'").run();

    expect(await vectorStore.getChunks("user-1", ["c1"])).not.toEqual([expect.objectContaining({ sectionPath: expect.anything() })]);
  });
});
