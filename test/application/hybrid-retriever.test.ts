import { beforeEach, describe, expect, it } from "vitest";
import { HybridRetriever } from "../../src/application/hybrid-retriever.js";
import type { VectorStore } from "../../src/application/ports/vector-store.js";
import { createTestStores, KeywordEmbeddings, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let embeddings: KeywordEmbeddings;

const baseOptions = { topK: 3, minScore: 0.2, semanticLimit: 10, lexicalLimit: 10, contextMaxChars: 10_000 };

function createRetriever(overrides: Partial<typeof baseOptions> = {}, vectorStore: VectorStore = stores.vectorStore) {
  // A clock that advances 5ms per reading makes every stage duration deterministic.
  let tick = 0;
  return new HybridRetriever({
    embeddings,
    vectorStore,
    options: { ...baseOptions, ...overrides },
    now: () => (tick += 5),
  });
}

async function index(userId: string, documentId: string, fileName: string, texts: string[], model = "test-model") {
  await stores.documents.saveWithChunks(
    makeDocument({ id: documentId, userId, fileName }),
    await Promise.all(
      texts.map(async (content, chunkIndex) =>
        makeChunk({
          id: `${documentId}-${chunkIndex}`,
          documentId,
          userId,
          chunkIndex,
          content,
          embedding: await embeddings.embedQuery(content),
          embeddingModel: model,
        }),
      ),
    ),
  );
}

const retrieve = (retriever: HybridRetriever, question: string, userId = "user-1", documentId?: string) =>
  retriever.retrieve({ userId, question, documentId });

beforeEach(() => {
  stores = createTestStores();
  embeddings = new KeywordEmbeddings();
});

describe("HybridRetriever", () => {
  it("finds a chunk that only matches by an exact term, next to the semantic match", async () => {
    await index("user-1", "doc-1", "ops.md", [
      "the cat sleeps on the sofa",
      "Error ECONNRESET is raised by the upstream proxy", // no embedding keyword: invisible to vectors
      "unrelated gardening notes",
    ]);

    const { chunks } = await retrieve(createRetriever(), "cat ECONNRESET");

    expect(chunks.map((chunk) => chunk.chunkId)).toEqual(["doc-1-0", "doc-1-1"]);
    expect(chunks[0].ranking).toMatchObject({ semanticRank: 1, lexicalRank: 1, fusedRank: 1 });
    expect(chunks[1].ranking.semanticRank).toBeUndefined();
    expect(chunks[1].ranking).toMatchObject({ lexicalRank: 2, fusedRank: 2 });
    expect(chunks[1]).toMatchObject({ fileName: "ops.md", chunkIndex: 1, content: expect.stringContaining("ECONNRESET") });
  });

  it("still works semantically when the question shares no words with the text", async () => {
    await index("user-1", "doc-1", "pets.md", ["cat cat cat"]);

    const { chunks } = await retrieve(createRetriever(), "feline? maybe a cat");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].ranking.semanticRank).toBe(1);
  });

  it("keeps old documents findable by keywords when their embeddings are stale, and never mixes models", async () => {
    await index("user-1", "doc-1", "old.md", ["the cat sleeps with ECONNRESET"], "legacy-model");

    const { chunks } = await retrieve(createRetriever(), "ECONNRESET cat");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].ranking.semanticRank).toBeUndefined();
    expect(chunks[0].ranking.lexicalRank).toBe(1);
  });

  it("is user-isolated in both retrieval paths", async () => {
    await index("user-2", "doc-2", "secret.md", ["the cat knows the ECONNRESET secret"]);

    const { chunks, trace } = await retrieve(createRetriever(), "cat ECONNRESET", "user-1");

    expect(chunks).toEqual([]);
    expect(trace.counts).toMatchObject({ semantic: 0, lexical: 0, selected: 0 });
  });

  it("scopes both paths to one document when asked", async () => {
    await index("user-1", "doc-1", "a.md", ["cat one"]);
    await index("user-1", "doc-2", "b.md", ["cat two"]);

    const { chunks } = await retrieve(createRetriever(), "cat", "user-1", "doc-2");

    expect(chunks.map((chunk) => chunk.documentId)).toEqual(["doc-2"]);
  });

  it("only loads text for a bounded candidate pool, not for every match", async () => {
    await index("user-1", "doc-1", "big.md", Array.from({ length: 30 }, (_, i) => `cat note ${i}`));
    const requested: string[][] = [];
    const spy = Object.assign(Object.create(stores.vectorStore) as VectorStore, {
      getChunks: async (userId: string, ids: string[]) => {
        requested.push(ids);
        return stores.vectorStore.getChunks(userId, ids);
      },
    });

    const { trace } = await retrieve(createRetriever({ topK: 2, semanticLimit: 30, lexicalLimit: 30 }, spy), "cat");

    expect(trace.counts.semantic).toBe(30);
    expect(requested).toHaveLength(1);
    expect(requested[0].length).toBeLessThanOrEqual(6); // topK * 3
  });

  it("drops candidates that disappear between ranking and loading (concurrent delete)", async () => {
    await index("user-1", "doc-1", "a.md", ["cat one", "cat cat two"]);
    const racing = Object.assign(Object.create(stores.vectorStore) as VectorStore, {
      getChunks: async (userId: string, ids: string[]) => (await stores.vectorStore.getChunks(userId, ids)).slice(1),
    });

    const { chunks, trace } = await retrieve(createRetriever({}, racing), "cat");

    expect(chunks).toHaveLength(1);
    expect(trace.counts.fused).toBe(2);
    expect(trace.counts.selected).toBe(1);
  });

  it("applies diversification and the context budget to the final chunks", async () => {
    await index("user-1", "doc-1", "a.md", ["cat one", "cat two", "cat three"]);
    await index("user-1", "doc-2", "b.md", ["cat four"]);

    const capped = await retrieve(createRetriever({ topK: 4 }), "cat");
    expect(capped.chunks).toHaveLength(4); // per-document cap is soft: free slots are backfilled

    const budgeted = await retrieve(createRetriever({ topK: 4, contextMaxChars: 18 }), "cat");
    expect(budgeted.chunks.reduce((sum, chunk) => sum + chunk.content.length, 0)).toBeLessThanOrEqual(18);
    expect(budgeted.trace.skipped.some((item) => item.reason === "budget")).toBe(true);
  });

  it("reports stage timings, candidate counts and the selected context size", async () => {
    await index("user-1", "doc-1", "a.md", ["cat one", "ECONNRESET two"]);

    const { trace } = await retrieve(createRetriever(), "cat ECONNRESET");

    expect(trace.timings).toEqual({
      embeddingMs: 5,
      semanticMs: 5,
      lexicalMs: 5,
      fusionMs: 5,
      contextMs: 5,
      totalMs: expect.any(Number),
    });
    expect(trace.counts).toEqual({ semantic: 1, lexical: 2, fused: 2, loaded: 2, selected: 2 });
    expect(trace.contextChars).toBe("cat one".length + "ECONNRESET two".length);
  });

  it("returns an empty result without loading anything when nothing matches", async () => {
    await index("user-1", "doc-1", "a.md", ["tax rules"]);

    const { chunks, trace } = await retrieve(createRetriever(), "cat?");

    expect(chunks).toEqual([]);
    expect(trace.counts.fused).toBe(0);
  });

  it("rejects a malformed query embedding as a provider failure", async () => {
    embeddings.embedQuery = async () => [Number.NaN];

    await expect(retrieve(createRetriever(), "cat?")).rejects.toThrow(/temporarily unavailable/);
  });
});
