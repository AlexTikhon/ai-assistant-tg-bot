import { beforeEach, describe, expect, it } from "vitest";
import { checkIndexCompatibility } from "../../src/application/check-index-compatibility.js";
import { HybridRetriever } from "../../src/application/hybrid-retriever.js";
import { ReindexDocumentUseCase } from "../../src/application/use-cases/reindex-document.use-case.js";
import { RunReindexUseCase } from "../../src/application/use-cases/run-reindex.use-case.js";
import type { ReindexProgress } from "../../src/application/use-cases/run-reindex.use-case.js";
import { ExternalServiceError, NotFoundError } from "../../src/shared/errors.js";
import { createTestStores, KeywordEmbeddings, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;

const NEW_MODEL = "new-model";

async function seed(userId: string, documentId: string, texts: string[], model = "test-model", dimension = 4) {
  await stores.documents.saveWithChunks(
    makeDocument({ id: documentId, userId, fileName: `${documentId}.txt` }),
    texts.map((content, chunkIndex) =>
      makeChunk({
        id: `${documentId}-${chunkIndex}`,
        documentId,
        userId,
        chunkIndex,
        content,
        embedding: Array.from({ length: dimension }, (_, i) => (i === 0 ? 1 : 0)),
        embeddingModel: model,
      }),
    ),
  );
}

function createRunner(embeddings: KeywordEmbeddings) {
  const reindexDocument = new ReindexDocumentUseCase({ ...stores, embeddings });
  return new RunReindexUseCase({ maintenance: stores.maintenance, reindexDocument, embeddings });
}

const models = () =>
  stores.db.prepare("SELECT document_id AS d, embedding_model AS m FROM document_chunks ORDER BY document_id, chunk_index").all();

beforeEach(() => {
  stores = createTestStores();
});

describe("stale embedding detection", () => {
  it("reports how many documents and chunks do not match the configured model", async () => {
    await seed("user-1", "fresh", ["a"], NEW_MODEL);
    await seed("user-1", "stale-1", ["a", "b"], "old-model");
    await seed("user-2", "stale-2", ["a"], "other-model");
    const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];

    const summary = await checkIndexCompatibility(stores.maintenance, NEW_MODEL, {
      warn: (fields: Record<string, unknown>, message: string) => void warnings.push({ fields, message }),
    });

    expect(summary).toEqual({ staleDocuments: 2, staleChunks: 3 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].fields).toMatchObject({ embeddingModel: NEW_MODEL, staleDocuments: 2, staleChunks: 3 });
    expect(warnings[0].message).toContain("npm run reindex");
  });

  it("stays silent when everything matches, and never calls an API", async () => {
    await seed("user-1", "fresh", ["a"], NEW_MODEL);
    const warnings: unknown[] = [];

    const summary = await checkIndexCompatibility(stores.maintenance, NEW_MODEL, { warn: () => void warnings.push(1) });

    expect(summary).toEqual({ staleDocuments: 0, staleChunks: 0 });
    expect(warnings).toEqual([]);
  });

  it("also flags unreadable vectors", async () => {
    await seed("user-1", "broken", ["a"], NEW_MODEL);
    stores.db.prepare("UPDATE document_chunks SET embedding = x'', embedding_dim = 0").run();

    expect(await checkIndexCompatibility(stores.maintenance, NEW_MODEL, { warn: () => undefined })).toEqual({
      staleDocuments: 1,
      staleChunks: 1,
    });
  });
});

describe("ReindexDocumentUseCase", () => {
  it("re-embeds every chunk of the document with the new model and keeps the text", async () => {
    await seed("user-1", "doc-1", ["the cat sleeps", "the dog barks"], "old-model");
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);

    const result = await new ReindexDocumentUseCase({ ...stores, embeddings }).execute("user-1", "doc-1");

    expect(result).toEqual({ chunksCount: 2 });
    expect(models()).toEqual([
      { d: "doc-1", m: NEW_MODEL },
      { d: "doc-1", m: NEW_MODEL },
    ]);
    expect(await stores.vectorStore.listByDocument("user-1", "doc-1")).toEqual([
      { chunkIndex: 0, content: "the cat sleeps" },
      { chunkIndex: 1, content: "the dog barks" },
    ]);
    expect(embeddings.documentCalls).toEqual([["the cat sleeps", "the dog barks"]]);
  });

  it("makes the document semantically searchable again", async () => {
    await seed("user-1", "doc-1", ["the cat sleeps"], "old-model");
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);
    const retriever = new HybridRetriever({
      embeddings,
      vectorStore: stores.vectorStore,
      options: { topK: 3, minScore: 0.2, semanticLimit: 5, lexicalLimit: 5, contextMaxChars: 5000 },
    });
    const before = await retriever.retrieve({ userId: "user-1", question: "kitty" });
    expect(before.chunks).toEqual([]);

    await new ReindexDocumentUseCase({ ...stores, embeddings }).execute("user-1", "doc-1");

    const after = await retriever.retrieve({ userId: "user-1", question: "cat" });
    expect(after.chunks[0].ranking.semanticRank).toBe(1);
  });

  it("does not touch another user's document", async () => {
    await seed("user-1", "doc-1", ["a"], "old-model");

    await expect(
      new ReindexDocumentUseCase({ ...stores, embeddings: new KeywordEmbeddings() }).execute("user-2", "doc-1"),
    ).rejects.toThrow(NotFoundError);
    expect(models()).toEqual([{ d: "doc-1", m: "old-model" }]);
  });

  it("leaves the existing chunks untouched when the provider fails", async () => {
    await seed("user-1", "doc-1", ["a", "b"], "old-model");
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);
    embeddings.failWith = new ExternalServiceError("openai");

    await expect(new ReindexDocumentUseCase({ ...stores, embeddings }).execute("user-1", "doc-1")).rejects.toThrow(
      ExternalServiceError,
    );

    expect(models().every((row) => (row as { m: string }).m === "old-model")).toBe(true);
    expect((await stores.vectorStore.listByDocument("user-1", "doc-1")).length).toBe(2);
  });

  it("leaves the chunks untouched when the provider returns the wrong number of vectors", async () => {
    await seed("user-1", "doc-1", ["a", "b"], "old-model");
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);
    embeddings.documentVectorsOverride = [[1, 0, 0, 0]];

    await expect(new ReindexDocumentUseCase({ ...stores, embeddings }).execute("user-1", "doc-1")).rejects.toThrow(
      /temporarily unavailable/,
    );

    expect(models().every((row) => (row as { m: string }).m === "old-model")).toBe(true);
  });
});

describe("RunReindexUseCase", () => {
  it("re-indexes only stale documents by default", async () => {
    await seed("user-1", "fresh", ["a"], NEW_MODEL);
    await seed("user-1", "stale", ["a"], "old-model");
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);

    const report = await createRunner(embeddings).execute({ scope: { kind: "stale" } });

    expect(report).toMatchObject({ documents: 1, succeeded: 1, failed: [], chunksReindexed: 1, dryRun: false });
    expect(embeddings.documentCalls).toHaveLength(1);
    expect(models()).toEqual([
      { d: "fresh", m: NEW_MODEL },
      { d: "stale", m: NEW_MODEL },
    ]);
  });

  it("treats a changed embedding dimension of the same model as stale (found by probing the provider)", async () => {
    await seed("user-1", "doc-1", ["a"], NEW_MODEL, 4);
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space", "moon"], NEW_MODEL); // now 5-dimensional

    const report = await createRunner(embeddings).execute({ scope: { kind: "stale" } });

    expect(report).toMatchObject({ dimension: 5, documents: 1, succeeded: 1 });
    expect(stores.db.prepare("SELECT embedding_dim AS d FROM document_chunks").get()).toEqual({ d: 5 });
  });

  it("one failing document does not stop the others or damage anything", async () => {
    await seed("user-1", "doc-a", ["alpha cat"], "old-model");
    await seed("user-1", "doc-b", ["broken text"], "old-model");
    await seed("user-1", "doc-c", ["gamma dog"], "old-model");
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);
    const original = embeddings.embedDocuments.bind(embeddings);
    embeddings.embedDocuments = async (texts) => {
      if (texts.includes("broken text")) throw new ExternalServiceError("openai");
      return original(texts);
    };
    const progress: ReindexProgress[] = [];

    const report = await createRunner(embeddings).execute({ scope: { kind: "stale" }, onProgress: (item) => progress.push(item) });

    expect(report.succeeded).toBe(2);
    expect(report.failed).toEqual([
      { documentId: "doc-b", fileName: "doc-b.txt", reason: expect.stringContaining("temporarily unavailable") },
    ]);
    expect(models()).toEqual([
      { d: "doc-a", m: NEW_MODEL },
      { d: "doc-b", m: "old-model" },
      { d: "doc-c", m: NEW_MODEL },
    ]);
    expect(progress.map((item) => [item.position, item.total, item.documentId, item.outcome])).toEqual([
      [1, 3, "doc-a", "reindexed"],
      [2, 3, "doc-b", "failed"],
      [3, 3, "doc-c", "reindexed"],
    ]);
  });

  it("a rerun after a failure picks up exactly the documents that are still stale", async () => {
    await seed("user-1", "doc-a", ["a"], "old-model");
    await seed("user-1", "doc-b", ["b"], "old-model");
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);
    const original = embeddings.embedDocuments.bind(embeddings);
    embeddings.embedDocuments = async (texts) => {
      if (texts.includes("b")) throw new ExternalServiceError("openai");
      return original(texts);
    };
    await createRunner(embeddings).execute({ scope: { kind: "stale" } });
    embeddings.embedDocuments = original;

    const second = await createRunner(embeddings).execute({ scope: { kind: "stale" } });

    expect(second).toMatchObject({ documents: 1, succeeded: 1 });
    expect(models().every((row) => (row as { m: string }).m === NEW_MODEL)).toBe(true);
  });

  it("--all re-embeds up-to-date documents too", async () => {
    await seed("user-1", "fresh", ["a"], NEW_MODEL);
    await seed("user-2", "other", ["b"], NEW_MODEL);

    const report = await createRunner(new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL)).execute({
      scope: { kind: "all" },
    });

    expect(report).toMatchObject({ documents: 2, succeeded: 2 });
  });

  it("--document re-indexes one document (even a fresh one) and reports unknown ids", async () => {
    await seed("user-1", "fresh", ["a"], NEW_MODEL);
    await seed("user-1", "stale", ["b"], "old-model");
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);
    const runner = createRunner(embeddings);

    expect(await runner.execute({ scope: { kind: "document", documentId: "fresh" } })).toMatchObject({ documents: 1, succeeded: 1 });
    expect(embeddings.documentCalls).toEqual([["a"]]);
    expect(models()).toContainEqual({ d: "stale", m: "old-model" });

    await expect(runner.execute({ scope: { kind: "document", documentId: "nope" } })).rejects.toThrow(NotFoundError);
  });

  it("dry run lists what would be re-indexed without calling the provider or changing anything", async () => {
    await seed("user-1", "stale", ["a", "b"], "old-model");
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);
    const progress: ReindexProgress[] = [];

    const report = await createRunner(embeddings).execute({
      scope: { kind: "stale" },
      dryRun: true,
      onProgress: (item) => progress.push(item),
    });

    expect(report).toMatchObject({ documents: 1, chunks: 2, succeeded: 0, dryRun: true });
    expect(progress.map((item) => item.outcome)).toEqual(["planned"]);
    expect(embeddings.documentCalls).toEqual([]);
    expect(models()).toEqual([
      { d: "stale", m: "old-model" },
      { d: "stale", m: "old-model" },
    ]);
  });

  it("does nothing, and spends nothing, when the index is already healthy", async () => {
    await seed("user-1", "fresh", ["a"], NEW_MODEL);
    const embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], NEW_MODEL);

    const report = await createRunner(embeddings).execute({ scope: { kind: "stale" } });

    expect(report).toMatchObject({ documents: 0, succeeded: 0 });
    expect(embeddings.documentCalls).toEqual([]);
  });
});
