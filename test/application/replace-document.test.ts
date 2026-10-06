import { beforeEach, describe, expect, it } from "vitest";
import type { DocumentRepository } from "../../src/application/ports/document-repository.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { ReplaceDocumentUseCase } from "../../src/application/use-cases/replace-document.use-case.js";
import type { ReplaceDocumentResult } from "../../src/application/use-cases/replace-document.use-case.js";
import { hashContent } from "../../src/core/content-hash.js";
import { NotFoundError, ValidationError } from "../../src/shared/errors.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;
let embeddings: KeywordEmbeddings;
let extractor: Utf8Extractor;
let events: string[];

const options = {
  maxUploadBytes: 100_000,
  chunkSize: 200,
  chunkOverlap: 20,
  maxDocumentsPerUser: 10,
  maxStorageBytesPerUser: 1_000_000,
  maxChunksPerDocument: 100,
};

const V1 = "The cat sleeps all day on the sofa. ".repeat(12);
const V2 = "Quarterly tax forms are due in April. ".repeat(12);

const deps = (documents: DocumentRepository = stores.documents) => ({ documents, files, extractor, embeddings, options });
const ingest = () => new IngestDocumentUseCase(deps());
const replacer = (documents?: DocumentRepository) => new ReplaceDocumentUseCase(deps(documents));

const file = (text: string, overrides: Partial<{ userId: string; fileName: string }> = {}) => ({
  userId: overrides.userId ?? "user-1",
  fileName: overrides.fileName ?? "notes.txt",
  mimeType: "text/plain",
  data: Buffer.from(text),
});

const replaceInput = (documentId: string, text: string, overrides: Partial<{ userId: string; fileName: string }> = {}) => ({
  ...file(text, overrides),
  documentId,
});

async function seed(text = V1, userId = "user-1") {
  const created = await ingest().execute(file(text, { userId }));
  return created.documentId;
}

const chunkTexts = (documentId: string) =>
  (stores.db.prepare("SELECT content FROM document_chunks WHERE document_id = ? ORDER BY chunk_index").all(documentId) as Array<{ content: string }>).map(
    (row) => row.content,
  );

function replaced(result: ReplaceDocumentResult) {
  expect(result.kind).toBe("replaced");
  return result as Extract<ReplaceDocumentResult, { kind: "replaced" }>;
}

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  embeddings = new KeywordEmbeddings();
  extractor = new Utf8Extractor();
  events = [];
});

describe("ReplaceDocumentUseCase: success", () => {
  it("credits the old chunks when replacing at the user quota and rejects growth before embeddings", async () => {
    const id = await seed("A cat lives here.");
    const limited = new ReplaceDocumentUseCase({ ...deps(), options: { ...options, maxChunksPerUser: 1 } });
    expect((await limited.execute(replaceInput(id, "A dog lives here."))).kind).toBe("replaced");
    const before = await stores.documents.findById("user-1", id);
    embeddings.documentCalls.length = 0;
    await expect(limited.execute(replaceInput(id, V2))).rejects.toBeInstanceOf(ValidationError);
    expect(embeddings.documentCalls).toHaveLength(0);
    expect(await stores.documents.findById("user-1", id)).toEqual(before);
    expect(await stores.documents.countChunksForUser("user-1")).toBe(1);
  });

  it("swaps the content of the same document: same id, new version, new index, new file; the old file is removed", async () => {
    const id = await seed();
    const before = await stores.documents.findById("user-1", id);

    const result = replaced(await replacer().execute(replaceInput(id, V2, { fileName: "notes-v2.txt" })));

    expect(result).toMatchObject({ documentId: id, fileName: "notes-v2.txt", documentVersion: 2 });
    expect(await stores.documents.findById("user-1", id)).toMatchObject({
      id,
      fileName: "notes-v2.txt",
      contentHash: hashContent(Buffer.from(V2)),
      previousContentHash: before?.contentHash,
      documentVersion: 2,
      createdAt: before?.createdAt,
      summary: null,
    });
    expect((await stores.documents.findById("user-1", id))?.updatedAt).not.toBeNull();
    expect(chunkTexts(id).join(" ")).toContain("tax forms");
    expect(chunkTexts(id).join(" ")).not.toContain("sofa");
    expect([...files.files.keys()]).toEqual([(await stores.documents.findById("user-1", id))?.storedName]);
    expect(files.files.has(before!.storedName)).toBe(false);
  });

  it("records the profile of the new index and finds the new text, not the old", async () => {
    const id = await seed();
    await replacer().execute(replaceInput(id, V2));

    expect(await stores.vectorStore.searchLexical({ userId: "user-1", query: "tax", limit: 3 })).not.toHaveLength(0);
    expect(await stores.vectorStore.searchLexical({ userId: "user-1", query: "sofa", limit: 3 })).toHaveLength(0);
    expect((await stores.documents.findById("user-1", id))?.indexProfile).toMatchObject({ embeddingModel: "test-model", chunkSize: 200 });
  });

  it("clears the cached summary: it described the old content", async () => {
    const id = await seed();
    await stores.documents.updateSummary("user-1", id, "A story about a cat.");

    await replacer().execute(replaceInput(id, V2));

    expect((await stores.documents.findById("user-1", id))?.summary).toBeNull();
  });

  it("prepares everything before it touches anything: embed, then write the new file, then swap, then remove the old file", async () => {
    const id = await seed();
    const documents = Object.create(stores.documents, {
      replaceDocument: {
        value: async (...args: Parameters<DocumentRepository["replaceDocument"]>) => {
          events.push("swap");
          return stores.documents.replaceDocument(...args);
        },
      },
    }) as DocumentRepository;
    const embedDocuments = embeddings.embedDocuments.bind(embeddings);
    embeddings.embedDocuments = async (texts) => (events.push("embed"), embedDocuments(texts));
    const save = files.save.bind(files);
    files.save = async (name, data) => (events.push("save-new-file"), save(name, data));
    const remove = files.delete.bind(files);
    files.delete = async (name) => (events.push("delete-old-file"), remove(name));

    await replacer(documents).execute(replaceInput(id, V2));

    expect(events).toEqual(["embed", "save-new-file", "swap", "delete-old-file"]);
  });
});

describe("ReplaceDocumentUseCase: nothing to replace", () => {
  it("answers already-exists without any work when the document already has exactly these bytes and a current index", async () => {
    const id = await seed();
    embeddings.documentCalls.length = 0;
    const extractions = extractor.calls;

    const result = await replacer().execute(replaceInput(id, V1));

    expect(result).toMatchObject({ kind: "already-exists", documentId: id });
    expect(embeddings.documentCalls).toHaveLength(0);
    expect(extractor.calls).toBe(extractions);
    expect((await stores.documents.findById("user-1", id))?.documentVersion).toBe(1);
  });

  it("rebuilds a document with the same bytes when its index is not usable (an explicit repair the user asked for)", async () => {
    const id = await seed();
    stores.db.prepare("DELETE FROM document_chunks WHERE document_id = ?").run(id);

    const result = replaced(await replacer().execute(replaceInput(id, V1)));

    expect(result.chunksCount).toBeGreaterThan(0);
    expect(chunkTexts(id).length).toBeGreaterThan(0);
  });

  it("refuses content the user already has as another document, naming that document", async () => {
    const id = await seed(V1);
    const other = await seed(V2);

    await expect(replacer().execute(replaceInput(id, V2))).rejects.toThrow(new RegExp(other));

    expect((await stores.documents.findById("user-1", id))?.documentVersion).toBe(1);
  });
});

describe("ReplaceDocumentUseCase: failures keep the previous document usable", () => {
  async function expectUntouched(id: string, original: Awaited<ReturnType<typeof stores.documents.findById>>, originalChunks: string[]) {
    expect(await stores.documents.findById("user-1", id)).toEqual(original);
    expect(chunkTexts(id)).toEqual(originalChunks);
    expect([...files.files.keys()]).toEqual([original!.storedName]); // no stray new file, the old one is still there
  }

  it("extraction failure", async () => {
    const id = await seed();
    const original = await stores.documents.findById("user-1", id);
    const originalChunks = chunkTexts(id);
    extractor.failWith = new Error("corrupt pdf");

    await expect(replacer().execute(replaceInput(id, V2))).rejects.toThrow("corrupt pdf");

    await expectUntouched(id, original, originalChunks);
  });

  it("embedding failure", async () => {
    const id = await seed();
    const original = await stores.documents.findById("user-1", id);
    const originalChunks = chunkTexts(id);
    embeddings.failWith = new Error("provider down");

    await expect(replacer().execute(replaceInput(id, V2))).rejects.toThrow("provider down");

    await expectUntouched(id, original, originalChunks);
    expect(await stores.vectorStore.searchLexical({ userId: "user-1", query: "sofa", limit: 3 })).not.toHaveLength(0);
  });

  it("an invalid embedding batch (wrong vector count)", async () => {
    const id = await seed();
    const original = await stores.documents.findById("user-1", id);
    const originalChunks = chunkTexts(id);
    embeddings.documentVectorsOverride = [[1, 0, 0, 0]];

    await expect(replacer().execute(replaceInput(id, V2))).rejects.toThrow();

    await expectUntouched(id, original, originalChunks);
  });

  it("database failure during the swap removes the new file and keeps the old index", async () => {
    const id = await seed();
    const original = await stores.documents.findById("user-1", id);
    const originalChunks = chunkTexts(id);
    const failing = Object.create(stores.documents, {
      replaceDocument: { value: async () => Promise.reject(new Error("database is locked")) },
    }) as DocumentRepository;

    await expect(replacer(failing).execute(replaceInput(id, V2))).rejects.toThrow("database is locked");

    await expectUntouched(id, original, originalChunks);
  });

  it("still reports the database error when removing the new file also fails", async () => {
    const id = await seed();
    const failing = Object.create(stores.documents, {
      replaceDocument: { value: async () => Promise.reject(new Error("database is locked")) },
    }) as DocumentRepository;
    files.failOnDelete = true;

    await expect(replacer(failing).execute(replaceInput(id, V2))).rejects.toThrow("database is locked");
  });

  it("cannot store the new file: nothing changes", async () => {
    const id = await seed();
    const original = await stores.documents.findById("user-1", id);
    const originalChunks = chunkTexts(id);
    files.failOnSave = true;

    await expect(replacer().execute(replaceInput(id, V2))).rejects.toThrow("disk full");

    await expectUntouched(id, original, originalChunks);
  });

  it("cannot remove the old file after the swap: the replacement still succeeds and the leftover is only logged", async () => {
    const id = await seed();
    const before = await stores.documents.findById("user-1", id);
    files.failOnDelete = true;

    const result = await replacer().execute(replaceInput(id, V2));

    expect(result.kind).toBe("replaced");
    expect(await stores.documents.findById("user-1", id)).toMatchObject({ documentVersion: 2 });
    expect(files.files.has(before!.storedName)).toBe(true); // an orphan now; `npm run integrity` reports it
  });
});

describe("ReplaceDocumentUseCase: ownership and limits", () => {
  it("refuses another user's document before reading, extracting, embedding or storing anything", async () => {
    const id = await seed(V1, "owner");
    embeddings.documentCalls.length = 0;
    const filesBefore = files.files.size;
    const extractions = extractor.calls;

    await expect(replacer().execute(replaceInput(id, V2, { userId: "intruder" }))).rejects.toThrow(NotFoundError);

    expect(embeddings.documentCalls).toHaveLength(0);
    expect(extractor.calls).toBe(extractions);
    expect(files.files.size).toBe(filesBefore);
    expect((await stores.documents.findById("owner", id))?.documentVersion).toBe(1);
  });

  it("does not match the content hash against someone else's document", async () => {
    await seed(V2, "someone-else");
    const id = await seed(V1);

    const result = await replacer().execute(replaceInput(id, V2)); // the same bytes exist for another user: irrelevant

    expect(result.kind).toBe("replaced");
  });

  it("rejects unsupported, empty and oversized files before any work", async () => {
    const id = await seed();

    await expect(replacer().execute(replaceInput(id, V2, { fileName: "virus.exe" }))).rejects.toThrow(ValidationError);
    await expect(replacer().execute(replaceInput(id, ""))).rejects.toThrow(/empty/);
    await expect(replacer().execute(replaceInput(id, "x".repeat(options.maxUploadBytes + 1)))).rejects.toThrow(/too large/);
  });

  it("counts only the size difference against the storage limit: replacing never double-counts the old file", async () => {
    const small = { ...options, maxStorageBytesPerUser: V1.length + 50 };
    const useCase = new ReplaceDocumentUseCase({ ...deps(), options: small });
    const id = await seed();

    // V2 is a different file of similar size: it fits only because the old file's bytes are released.
    await expect(useCase.execute(replaceInput(id, `${V2.slice(0, V1.length)}`))).resolves.toMatchObject({ kind: "replaced" });
    await expect(useCase.execute(replaceInput(id, "y".repeat(V1.length + 100)))).rejects.toThrow(/storage limit/);
  });

  it("serializes with other operations of the same user", async () => {
    const id = await seed();
    const useCase = replacer();

    const results = await Promise.allSettled([useCase.execute(replaceInput(id, V2)), useCase.execute(replaceInput(id, V2))]);

    expect(results.map((result) => (result.status === "fulfilled" ? result.value.kind : "rejected")).sort()).toEqual(["already-exists", "replaced"]);
    expect((await stores.documents.findById("user-1", id))?.documentVersion).toBe(2);
  });
});

describe("ReplaceDocumentUseCase and summaries", () => {
  it("a summary that was being computed for the old content is not saved over the new content", async () => {
    const { SummarizeDocumentUseCase } = await import("../../src/application/use-cases/summarize-document.use-case.js");
    const { FakeChatModel } = await import("../support/fakes.js");
    const id = await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let modelEntered!: () => void;
    const entered = new Promise<void>((resolve) => (modelEntered = resolve));
    const chatModel = new FakeChatModel("unused");
    chatModel.complete = async () => (modelEntered(), await gate, "A summary of the OLD content.");
    const summarize = new SummarizeDocumentUseCase({ documents: stores.documents, vectorStore: stores.vectorStore, chatModel });

    const summarizing = summarize.execute("user-1", id); // reads the old chunks, then waits for the model
    await entered; // the old chunks have been read; only the model call is outstanding
    await replacer().execute(replaceInput(id, V2));
    release();
    await summarizing;

    expect((await stores.documents.findById("user-1", id))?.summary).toBeNull();
  });
});

describe("ReplaceDocumentUseCase restores a missing original when the same bytes are sent again", () => {
  it("restores the file without rebuilding the index", async () => {
    const id = await seed();
    const before = await stores.documents.findById("user-1", id);
    files.files.delete(before!.storedName);
    embeddings.documentCalls.length = 0;

    const result = await replacer().execute(replaceInput(id, V1));

    expect(result).toMatchObject({ kind: "already-exists", restoredOriginal: true });
    expect(embeddings.documentCalls).toHaveLength(0);
    const after = await stores.documents.findById("user-1", id);
    expect(files.files.get(after!.storedName)?.toString()).toBe(V1);
    expect(after?.documentVersion).toBe(1);
  });
});
