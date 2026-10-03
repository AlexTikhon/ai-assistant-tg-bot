import { beforeEach, describe, expect, it } from "vitest";
import { AnswerQuestionUseCase } from "../../src/application/use-cases/answer-question.use-case.js";
import { DeleteDocumentUseCase } from "../../src/application/use-cases/delete-document.use-case.js";
import { ReindexDocumentUseCase } from "../../src/application/use-cases/reindex-document.use-case.js";
import { NotFoundError } from "../../src/shared/errors.js";
import { createTestStores, FakeChatModel, InMemoryFileStorage, KeywordEmbeddings, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;

function rowCount(table: string) {
  return (stores.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(async () => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  files.files.set("stored-1", Buffer.from("data"));
  await stores.documents.saveWithChunks(makeDocument({ id: "doc-1", storedName: "stored-1" }), [
    makeChunk({ documentId: "doc-1", chunkIndex: 0, content: "the cat sleeps", embedding: [1, 0, 0, 0] }),
  ]);
});

describe("DeleteDocumentUseCase", () => {
  const createUseCase = () => new DeleteDocumentUseCase({ ...stores, files });

  it("deletes the document, its chunks and its file", async () => {
    await createUseCase().execute("user-1", "doc-1");

    expect(rowCount("documents")).toBe(0);
    expect(rowCount("document_chunks")).toBe(0);
    expect(files.files.size).toBe(0);
  });

  it("does not let another user delete the document (nothing is removed)", async () => {
    await expect(createUseCase().execute("user-2", "doc-1")).rejects.toThrow(NotFoundError);

    expect(rowCount("documents")).toBe(1);
    expect(rowCount("document_chunks")).toBe(1);
    expect(files.files.size).toBe(1);
  });

  it("reports unknown documents", async () => {
    await expect(createUseCase().execute("user-1", "nope")).rejects.toThrow(NotFoundError);
  });

  it("completes the deletion even if removing the file fails (database is the source of truth)", async () => {
    files.failOnDelete = true;

    await expect(createUseCase().execute("user-1", "doc-1")).resolves.toBeUndefined();

    expect(rowCount("documents")).toBe(0);
    expect(rowCount("document_chunks")).toBe(0);
    expect(files.files.size).toBe(1); // orphaned file: logged, not fatal
  });
});

describe("ReindexDocumentUseCase", () => {
  it("makes documents searchable again after the embeddings model changed", async () => {
    const newEmbeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], "new-model");
    const answer = new AnswerQuestionUseCase({
      embeddings: newEmbeddings,
      vectorStore: stores.vectorStore,
      chatModel: new FakeChatModel("A cat sleeps."),
      options: { topK: 3, minScore: 0.2 },
    });

    // Chunks were embedded with "test-model": invisible to the new model.
    expect((await answer.execute({ userId: "user-1", question: "cat?" })).sources).toEqual([]);

    const reindex = new ReindexDocumentUseCase({ ...stores, embeddings: newEmbeddings });
    expect(await reindex.execute("user-1", "doc-1")).toEqual({ chunksCount: 1 });

    const result = await answer.execute({ userId: "user-1", question: "cat?" });
    expect(result.sources).toHaveLength(1);
    expect(rowCount("document_chunks")).toBe(1); // replaced, not duplicated
    expect(stores.db.prepare("SELECT embedding_model AS m FROM document_chunks").get()).toEqual({ m: "new-model" });
  });

  it("does not re-index another user's document", async () => {
    const reindex = new ReindexDocumentUseCase({ ...stores, embeddings: new KeywordEmbeddings() });

    await expect(reindex.execute("user-2", "doc-1")).rejects.toThrow(NotFoundError);
  });
});
