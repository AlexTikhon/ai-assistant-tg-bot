import { beforeEach, describe, expect, it } from "vitest";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { InspectIntegrityUseCase } from "../../src/application/use-cases/inspect-integrity.use-case.js";
import type { IntegrityIssue, IntegrityReport } from "../../src/application/use-cases/inspect-integrity.use-case.js";
import { RepairIntegrityUseCase } from "../../src/application/use-cases/repair-integrity.use-case.js";
import { hashContent } from "../../src/core/content-hash.js";
import { SqliteIntegrityStore } from "../../src/infrastructure/sqlite/sqlite-integrity-store.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-03-10T12:00:00.000Z");
const recipe = { embeddingModel: "test-model", chunkSize: 200, chunkOverlap: 20 };

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;
let embeddings: KeywordEmbeddings;

const TEXT = (label: string) => `The cat sleeps all day (${label}). `.repeat(12);

async function ingest(fileName: string, text = TEXT(fileName), userId = "u1") {
  const result = await new IngestDocumentUseCase({
    documents: stores.documents,
    files,
    extractor: new Utf8Extractor(),
    embeddings,
    options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
  }).execute({ userId, fileName, mimeType: "text/plain", data: Buffer.from(text) });
  return result.documentId;
}

const store = () => new SqliteIntegrityStore(stores.db);
const inspector = (active = recipe, verifyHashes = true) =>
  new InspectIntegrityUseCase({ store: store(), maintenance: stores.maintenance, files, recipe: active, now: () => NOW, verifyHashes });
const repairer = () =>
  new RepairIntegrityUseCase({ inspect: inspector(), store: store(), documents: stores.documents, files, now: () => NOW });

const codes = (report: IntegrityReport) => report.issues.map((issue) => issue.code);
const issueFor = (report: IntegrityReport, code: IntegrityIssue["code"], documentId?: string) =>
  report.issues.find((issue) => issue.code === code && (documentId === undefined || issue.documentId === documentId));
const storedNameOf = async (id: string, userId = "u1") => (await stores.documents.findById(userId, id))!.storedName;

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  embeddings = new KeywordEmbeddings();
  files.defaultModifiedAtMs = NOW - 48 * HOUR;
});

describe("integrity check: a healthy installation", () => {
  it("reports nothing", async () => {
    await ingest("a.txt");
    await ingest("b.txt");

    const report = await inspector().execute();

    expect(report.issues).toEqual([]);
    expect(report.summary).toMatchObject({ documents: 2, errors: 0, warnings: 0 });
  });

  it("an empty installation is healthy too", async () => {
    expect((await inspector().execute()).issues).toEqual([]);
  });
});

describe("integrity check: files", () => {
  it("detects a document row whose physical file is missing", async () => {
    const id = await ingest("a.txt");
    files.files.delete(await storedNameOf(id));

    const report = await inspector().execute();

    expect(issueFor(report, "missing-file", id)).toMatchObject({ severity: "error", fileName: "a.txt" });
  });

  it("detects a file that no document row refers to, and only calls it removable once it is old enough", async () => {
    files.files.set("stray-old.txt", Buffer.from("junk"));
    files.files.set("stray-new.txt", Buffer.from("junk"));
    files.modifiedAtMs.set("stray-new.txt", NOW - 1000);

    const report = await inspector().execute();

    expect(report.issues.filter((issue) => issue.code === "orphan-file").map((issue) => [issue.file, issue.removable])).toEqual([
      ["stray-old.txt", true],
      ["stray-new.txt", false],
    ]);
  });

  it("reports leftovers of interrupted writes as temporary files, stale ones flagged", async () => {
    files.temporary.set(".tmp-1-a.part", { size: 4, modifiedAtMs: NOW - 5 * HOUR });
    files.temporary.set(".tmp-2-b.part", { size: 4, modifiedAtMs: NOW - 1000 });

    const report = await inspector().execute();

    expect(report.issues.filter((issue) => issue.code === "temporary-file").map((issue) => [issue.file, issue.removable])).toEqual([
      [".tmp-1-a.part", true],
      [".tmp-2-b.part", false],
    ]);
  });

  it("detects a stored file whose size no longer matches the record", async () => {
    const id = await ingest("a.txt");
    files.files.set(await storedNameOf(id), Buffer.from("truncated"));

    expect(codes(await inspector().execute())).toContain("file-size-mismatch");
  });

  it("detects a file whose bytes no longer match the recorded content hash", async () => {
    const id = await ingest("a.txt");
    const name = await storedNameOf(id);
    const original = files.files.get(name)!;
    files.files.set(name, Buffer.from("X".repeat(original.byteLength))); // same size, other bytes

    const report = await inspector().execute();

    expect(issueFor(report, "content-hash-mismatch", id)).toMatchObject({ severity: "error" });
    expect(codes(report)).not.toContain("file-size-mismatch");
  });

  it("can skip the (slow) hash verification", async () => {
    const id = await ingest("a.txt");
    const name = await storedNameOf(id);
    files.files.set(name, Buffer.from("X".repeat(files.files.get(name)!.byteLength)));

    expect(codes(await inspector(recipe, false).execute())).not.toContain("content-hash-mismatch");
  });
});

describe("integrity check: chunks and index", () => {
  it("detects a document with no chunks", async () => {
    const id = await ingest("a.txt");
    stores.db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);

    expect(issueFor(await inspector().execute(), "no-chunks", id)).toMatchObject({ severity: "error" });
  });

  it("detects an unreadable embedding payload, with how many chunks are affected", async () => {
    const id = await ingest("a.txt");
    stores.db.prepare("UPDATE document_chunks SET embedding = x'0102' WHERE document_id = ? AND chunk_index = 0").run(id);

    const issue = issueFor(await inspector().execute(), "unreadable-embedding", id);

    expect(issue).toMatchObject({ severity: "error" });
    expect(issue?.message).toMatch(/1 of \d+ chunks/);
  });

  it("detects chunks of one document with different embedding dimensions", async () => {
    const id = await ingest("a.txt");
    const blob = Buffer.alloc(8); // a valid 2-dimensional vector in a 4-dimensional document
    stores.db.prepare("UPDATE document_chunks SET embedding = ?, embedding_dim = 2 WHERE document_id = ? AND chunk_index = 0").run(blob, id);

    expect(codes(await inspector().execute())).toContain("mixed-dimensions");
  });

  it("detects missing or duplicated chunk positions", async () => {
    const id = await ingest("a.txt");
    stores.db.prepare("DELETE FROM document_chunks WHERE document_id = ? AND chunk_index = 1").run(id);

    expect(codes(await inspector().execute())).toContain("chunk-index-gap");
  });

  it("detects chunks that belong to another user than their document, and chunks of vanished documents", async () => {
    const id = await ingest("a.txt");
    // The schema refuses these rows (composite foreign key); a database written with foreign keys off, or damaged, can still contain them.
    stores.db.pragma("foreign_keys = OFF");
    stores.db.prepare("UPDATE document_chunks SET user_id = 'someone-else' WHERE document_id = ? AND chunk_index = 0").run(id);
    stores.db.prepare("DELETE FROM documents WHERE id = ?").run(await ingest("b.txt"));

    const codesFound = codes(await inspector().execute());

    expect(codesFound).toContain("foreign-chunk");
    expect(codesFound).toContain("orphan-chunks");
  });

  it("detects a full-text index that is out of step with the chunks", async () => {
    await ingest("a.txt");
    stores.db.exec("DROP TRIGGER chunks_fts_insert");
    await ingest("b.txt"); // chunks inserted without index entries

    const issue = issueFor(await inspector().execute(), "fts-mismatch");

    expect(issue).toMatchObject({ severity: "error" });
    expect(issue?.remedy).toMatch(/--repair/);
  });
});

describe("integrity check: identity", () => {
  it("reports documents whose content hash is unknown, as fixable from the original file", async () => {
    const id = await ingest("a.txt");
    stores.db.prepare("UPDATE documents SET content_hash = NULL WHERE id = ?").run(id);

    const issue = issueFor(await inspector().execute(), "unknown-content-hash", id);

    expect(issue).toMatchObject({ severity: "warning" });
    expect(issue?.remedy).toMatch(/--repair/);
  });

  it("reports the same content stored twice for one user, but not across users", async () => {
    const first = await ingest("a.txt", TEXT("same"));
    const second = await ingest("copy.txt", TEXT("same"), "u2"); // other user: legitimate
    const third = await ingest("b.txt", TEXT("other"));
    stores.db.prepare("UPDATE documents SET content_hash = ? WHERE id = ?").run(hashContent(Buffer.from(TEXT("same"))), third);
    stores.db.prepare("UPDATE documents SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(first);

    const report = await inspector().execute();
    const duplicates = report.issues.filter((issue) => issue.code === "duplicate-content");

    expect(duplicates.map((issue) => issue.documentId)).toEqual([third]); // the later one duplicates the older
    expect(duplicates[0].message).toContain(first);
    expect(report.issues.some((issue) => issue.documentId === second && issue.code === "duplicate-content")).toBe(false);
  });
});

describe("integrity check: stale index profiles and what fixes them", () => {
  it("reports an outdated embedding model as a re-embed", async () => {
    const id = await ingest("a.txt");

    const issue = issueFor(await inspector({ ...recipe, embeddingModel: "newer-model" }).execute(), "stale-index", id);

    expect(issue).toMatchObject({ severity: "warning", needs: "reembed" });
    expect(issue?.remedy).toBe("npm run reindex");
  });

  it("reports a different chunk layout as a re-chunk", async () => {
    const id = await ingest("a.txt");

    const issue = issueFor(await inspector({ ...recipe, chunkSize: 500 }).execute(), "stale-index", id);

    expect(issue).toMatchObject({ needs: "rechunk" });
    expect(issue?.remedy).toBe("npm run reindex -- --rechunk");
  });

  it("explains a Markdown document that predates section-aware extraction, and says re-chunk (not re-embed) is needed", async () => {
    const id = await ingest("api.md", "# Title\n\nThe cat sleeps all day. ".repeat(10));
    stores.db.prepare("UPDATE documents SET index_profile = json_set(index_profile, '$.extractorVersion', 'text-v1') WHERE id = ?").run(id);

    const report = await inspector().execute();
    const issue = issueFor(report, "stale-index", id);

    expect(issue?.message).toMatch(/Markdown/);
    expect(issue?.message).toMatch(/section/i);
    expect(issue).toMatchObject({ needs: "rechunk" });
    expect(report.summary).toMatchObject({ needsRechunk: 1, needsReembed: 0 });
  });

  it("summarises how many documents and chunks each command would touch", async () => {
    await ingest("a.txt");
    await ingest("b.txt");

    const report = await inspector({ ...recipe, embeddingModel: "newer-model" }).execute();

    expect(report.summary).toMatchObject({ needsReembed: 2, needsRechunk: 0 });
    expect(report.summary.chunksToEmbed).toBeGreaterThan(2);
  });
});

describe("integrity check is read-only", () => {
  it("never calls a write method of the store or the file storage, whatever it finds", async () => {
    const id = await ingest("a.txt");
    await ingest("b.txt");
    stores.db.prepare("UPDATE documents SET content_hash = NULL WHERE id = ?").run(id);
    files.files.set("stray.txt", Buffer.from("junk"));
    files.temporary.set(".tmp-1-x.part", { size: 1, modifiedAtMs: NOW - 9 * HOUR });
    const writes: string[] = [];
    const guard = <T extends object>(target: T, methods: string[]) =>
      new Proxy(target, {
        get(object, property, receiver) {
          if (methods.includes(String(property))) return () => void writes.push(String(property));
          return Reflect.get(object, property, receiver);
        },
      });

    await new InspectIntegrityUseCase({
      store: guard(store(), ["rebuildFullText"]),
      maintenance: stores.maintenance,
      files: guard(files, ["save", "delete", "deleteTemporary"]),
      recipe,
      now: () => NOW,
      verifyHashes: true,
    }).execute();

    expect(writes).toEqual([]);
  });

  it("leaves the database rows and the files exactly as they were", async () => {
    await ingest("a.txt");
    files.files.set("stray.txt", Buffer.from("junk"));
    const snapshot = () => ({
      documents: stores.db.prepare("SELECT * FROM documents ORDER BY id").all(),
      chunks: stores.db.prepare("SELECT id, content, embedding FROM document_chunks ORDER BY id").all(),
      fts: stores.db.prepare("SELECT id FROM chunk_fts_docsize ORDER BY id").all(),
      files: [...files.files.entries()],
    });
    const before = snapshot();

    await inspector().execute();

    expect(snapshot()).toEqual(before);
  });
});

describe("repair: safe, deterministic fixes only", () => {
  it("rebuilds the full-text index and says so", async () => {
    await ingest("a.txt");
    stores.db.exec("DROP TRIGGER chunks_fts_insert");
    await ingest("b.txt");

    const result = await repairer().execute({});

    expect(result.actions.map((action) => action.kind)).toContain("rebuilt-full-text-index");
    expect(codes(result.after)).not.toContain("fts-mismatch");
    expect(await stores.vectorStore.searchLexical({ userId: "u1", query: "cat", limit: 50 })).toHaveLength(
      (stores.db.prepare("SELECT COUNT(*) AS n FROM document_chunks").get() as { n: number }).n,
    );
  });

  it("backfills a missing content hash from the original file", async () => {
    const id = await ingest("a.txt", TEXT("hashme"));
    stores.db.prepare("UPDATE documents SET content_hash = NULL WHERE id = ?").run(id);

    const result = await repairer().execute({});

    expect(result.actions).toContainEqual({ kind: "backfilled-content-hash", documentId: id, fileName: "a.txt" });
    expect((await stores.documents.findById("u1", id))?.contentHash).toBe(hashContent(Buffer.from(TEXT("hashme"))));
    expect(codes(result.after)).not.toContain("unknown-content-hash");
  });

  it("leaves a document alone when its original is missing: it never guesses", async () => {
    const id = await ingest("a.txt");
    stores.db.prepare("UPDATE documents SET content_hash = NULL WHERE id = ?").run(id);
    files.files.clear();

    const result = await repairer().execute({});

    expect(result.actions).toEqual([]);
    expect((await stores.documents.findById("u1", id))?.contentHash).toBeNull();
    expect(codes(result.after)).toContain("missing-file");
  });

  it("deletes stale temporary files only, using the (fake) clock for 'stale'", async () => {
    files.temporary.set(".tmp-1-old.part", { size: 4, modifiedAtMs: NOW - 5 * HOUR });
    files.temporary.set(".tmp-2-active.part", { size: 4, modifiedAtMs: NOW - 60_000 }); // a write that may still be running

    const result = await repairer().execute({});

    expect(result.actions).toEqual([{ kind: "removed-temporary-file", file: ".tmp-1-old.part" }]);
    expect([...files.temporary.keys()]).toEqual([".tmp-2-active.part"]);
  });

  it("does not delete orphan files, documents or anything else by default", async () => {
    const id = await ingest("a.txt");
    files.files.set("stray.txt", Buffer.from("junk"));
    stores.db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);

    const result = await repairer().execute({});

    expect(files.files.has("stray.txt")).toBe(true);
    expect(await stores.documents.findById("u1", id)).not.toBeNull();
    expect(result.actions).toEqual([]);
  });

  it("removes old orphan files only when explicitly asked, and keeps young ones", async () => {
    files.files.set("stray-old.txt", Buffer.from("junk"));
    files.files.set("stray-new.txt", Buffer.from("junk"));
    files.modifiedAtMs.set("stray-new.txt", NOW - 1000);

    const result = await repairer().execute({ removeOrphans: true });

    expect(result.actions).toEqual([{ kind: "removed-orphan-file", file: "stray-old.txt" }]);
    expect([...files.files.keys()]).toEqual(["stray-new.txt"]);
  });

  it("never removes a file a document refers to, even when asked to remove orphans", async () => {
    const id = await ingest("a.txt");

    await repairer().execute({ removeOrphans: true });

    expect(files.files.has(await storedNameOf(id))).toBe(true);
  });

  it("reports a failing step as failed and carries on with the others", async () => {
    files.temporary.set(".tmp-1-old.part", { size: 4, modifiedAtMs: NOW - 5 * HOUR });
    const id = await ingest("a.txt", TEXT("x"));
    stores.db.prepare("UPDATE documents SET content_hash = NULL WHERE id = ?").run(id);
    files.failOnDelete = true;

    const result = await repairer().execute({});

    expect(result.actions.map((action) => action.kind).sort()).toEqual(["backfilled-content-hash", "failed"]);
  });

  it("has no way to reach an embeddings provider", () => {
    // The use cases are constructed from stores, files and a clock only: there is nothing to call OpenAI with.
    expect(Object.keys((repairer() as unknown as { deps: object }).deps).sort()).toEqual(["documents", "files", "inspect", "now", "store"]);
  });
});
