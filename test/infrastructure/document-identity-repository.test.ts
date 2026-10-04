import { beforeEach, describe, expect, it } from "vitest";
import type { DocumentReplacement } from "../../src/application/ports/document-repository.js";
import { hashContent } from "../../src/core/content-hash.js";
import { buildIndexProfile } from "../../src/core/index-profile.js";
import { NotFoundError } from "../../src/shared/errors.js";
import { createTestStores, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;

const hashOf = (text: string) => hashContent(Buffer.from(text));
const profile = (fileName = "notes.txt") =>
  buildIndexProfile({ fileName, embeddingModel: "test-model", embeddingDimension: 4, chunkSize: 200, chunkOverlap: 20 });

const newChunk = (id: string, chunkIndex: number, content: string) => makeChunk({ id, documentId: "d1", userId: "u1", chunkIndex, content });

function replacement(overrides: Partial<DocumentReplacement> = {}): DocumentReplacement {
  return {
    fileName: "notes-v2.txt",
    storedName: "stored-v2.txt",
    mimeType: "text/plain",
    fileSize: 222,
    textLength: 200,
    contentHash: hashOf("v2"),
    indexProfile: profile("notes-v2.txt"),
    updatedAt: "2026-02-01T00:00:00.000Z",
    chunks: [newChunk("new-0", 0, "fresh text"), newChunk("new-1", 1, "more fresh text")],
    ...overrides,
  };
}

async function seed(id: string, userId: string, text: string, extra: Parameters<typeof makeDocument>[0] = {}) {
  await stores.documents.saveWithChunks(
    makeDocument({ id, userId, contentHash: hashOf(text), storedName: `stored-${id}`, ...extra }),
    [makeChunk({ id: `${id}-c0`, documentId: id, userId, chunkIndex: 0, content: `${text} old chunk` })],
  );
}

const rows = (sql: string, ...params: unknown[]) => stores.db.prepare(sql).all(...params);

beforeEach(() => {
  stores = createTestStores();
});

describe("document identity columns", () => {
  it("stores the content hash and starts at version 1", async () => {
    await seed("d1", "u1", "hello");

    expect(await stores.documents.findById("u1", "d1")).toMatchObject({
      contentHash: hashOf("hello"),
      documentVersion: 1,
      previousContentHash: null,
    });
  });

  it("keeps documents without a recorded hash valid: the hash is explicitly unknown", async () => {
    await stores.documents.saveWithChunks(makeDocument({ id: "old" }), [makeChunk({ documentId: "old" })]);

    expect(await stores.documents.findById("user-1", "old")).toMatchObject({ contentHash: null, documentVersion: 1 });
  });

  it("finds a document by hash only within the owner's documents", async () => {
    await seed("d1", "u1", "shared bytes");
    await seed("d2", "u2", "shared bytes");

    expect((await stores.documents.findByContentHash("u1", hashOf("shared bytes")))?.id).toBe("d1");
    expect((await stores.documents.findByContentHash("u2", hashOf("shared bytes")))?.id).toBe("d2");
    expect(await stores.documents.findByContentHash("u3", hashOf("shared bytes"))).toBeNull();
  });

  it("does not treat the same name with other bytes as the same content", async () => {
    await seed("d1", "u1", "version one", { fileName: "notes.pdf" });

    expect(await stores.documents.findByContentHash("u1", hashOf("version two"))).toBeNull();
  });

  it("lists unhashed documents of one user and size, and records a hash only once", async () => {
    await stores.documents.saveWithChunks(makeDocument({ id: "a", userId: "u1", fileSize: 10 }), [makeChunk({ documentId: "a", userId: "u1" })]);
    await stores.documents.saveWithChunks(makeDocument({ id: "b", userId: "u1", fileSize: 99 }), [makeChunk({ documentId: "b", userId: "u1" })]);
    await stores.documents.saveWithChunks(makeDocument({ id: "c", userId: "u2", fileSize: 10 }), [makeChunk({ documentId: "c", userId: "u2" })]);

    expect((await stores.documents.findUnhashedBySize("u1", 10)).map((document) => document.id)).toEqual(["a"]);

    expect(await stores.documents.setContentHash("u1", "a", hashOf("x"))).toBe(true);
    expect(await stores.documents.setContentHash("u1", "a", hashOf("y"))).toBe(false); // never overwrites a known hash
    expect(await stores.documents.setContentHash("u2", "a", hashOf("z"))).toBe(false); // not the owner
    expect((await stores.documents.findById("u1", "a"))?.contentHash).toBe(hashOf("x"));
    expect(await stores.documents.findUnhashedBySize("u1", 10)).toEqual([]);
  });
});

describe("replaceDocument (atomic swap)", () => {
  beforeEach(async () => {
    await seed("d1", "u1", "v1", { fileName: "notes.txt", fileSize: 111, summary: "old summary" });
  });

  it("swaps content, chunks, profile and version in one step and reports the file to clean up", async () => {
    const result = await stores.documents.replaceDocument("u1", "d1", replacement());

    expect(result).toEqual({ previousStoredName: "stored-d1", documentVersion: 2 });
    expect(await stores.documents.findById("u1", "d1")).toMatchObject({
      id: "d1",
      fileName: "notes-v2.txt",
      storedName: "stored-v2.txt",
      fileSize: 222,
      contentHash: hashOf("v2"),
      previousContentHash: hashOf("v1"),
      documentVersion: 2,
      updatedAt: "2026-02-01T00:00:00.000Z",
      summary: null, // the old summary described the old content
      indexProfile: profile("notes-v2.txt"),
    });
    expect(rows("SELECT id FROM document_chunks WHERE document_id = 'd1' ORDER BY chunk_index")).toEqual([{ id: "new-0" }, { id: "new-1" }]);
  });

  it("keeps the full-text index in step with the swap", async () => {
    await stores.documents.replaceDocument("u1", "d1", replacement());

    expect(await stores.vectorStore.searchLexical({ userId: "u1", query: "fresh", limit: 5 })).toHaveLength(2);
    expect(await stores.vectorStore.searchLexical({ userId: "u1", query: "old chunk", limit: 5 })).toHaveLength(0);
  });

  it("leaves the previous document and index untouched when the swap fails", async () => {
    const broken = replacement({ chunks: [newChunk("n0", 0, "a"), newChunk("n1", 0, "b")] }); // duplicate chunk index

    await expect(stores.documents.replaceDocument("u1", "d1", broken)).rejects.toThrow();

    expect(await stores.documents.findById("u1", "d1")).toMatchObject({ storedName: "stored-d1", documentVersion: 1, contentHash: hashOf("v1"), summary: "old summary" });
    expect(rows("SELECT id FROM document_chunks WHERE document_id = 'd1'")).toEqual([{ id: "d1-c0" }]);
    expect(await stores.vectorStore.searchLexical({ userId: "u1", query: "old", limit: 5 })).toHaveLength(1);
  });

  it("refuses to touch a document the user does not own", async () => {
    await expect(stores.documents.replaceDocument("intruder", "d1", replacement())).rejects.toThrow(NotFoundError);

    expect((await stores.documents.findById("u1", "d1"))?.storedName).toBe("stored-d1");
    expect(rows("SELECT id FROM document_chunks WHERE document_id = 'd1'")).toEqual([{ id: "d1-c0" }]);
  });
});

describe("replaceChunks records when the index was rebuilt", () => {
  const rebuild = (updatedAt?: string) => ({
    chunks: [newChunk("r0", 0, "rebuilt text")],
    indexProfile: profile(),
    textLength: 12,
    ...(updatedAt ? { updatedAt } : {}),
  });

  it("sets updatedAt when given, and leaves the content identity alone", async () => {
    await seed("d1", "u1", "v1");

    await stores.documents.replaceChunks("u1", "d1", rebuild("2026-05-05T00:00:00.000Z"));

    expect(await stores.documents.findById("u1", "d1")).toMatchObject({ updatedAt: "2026-05-05T00:00:00.000Z", contentHash: hashOf("v1"), documentVersion: 1 });
  });

  it("keeps the previous updatedAt when none is given", async () => {
    await seed("d1", "u1", "v1");
    await stores.documents.replaceChunks("u1", "d1", rebuild("2026-05-05T00:00:00.000Z"));

    await stores.documents.replaceChunks("u1", "d1", rebuild());

    expect((await stores.documents.findById("u1", "d1"))?.updatedAt).toBe("2026-05-05T00:00:00.000Z");
  });
});
