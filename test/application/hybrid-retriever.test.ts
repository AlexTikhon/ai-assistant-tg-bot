import { beforeEach, describe, expect, it, vi } from "vitest";
import { HybridRetriever } from "../../src/application/hybrid-retriever.js";
import type { RetrievalOptions } from "../../src/application/hybrid-retriever.js";
import type { LexicalSearch, VectorStore } from "../../src/application/ports/vector-store.js";
import { createTestStores, KeywordEmbeddings, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let embeddings: KeywordEmbeddings;

const baseOptions: RetrievalOptions = { topK: 3, minScore: 0.2, semanticLimit: 10, lexicalLimit: 10, contextMaxChars: 10_000, rrfK: undefined };

function createRetriever(overrides: Partial<RetrievalOptions> = {}, vectorStore: VectorStore = stores.vectorStore) {
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

    // The vector and full-text searches overlap (see the tests below): their durations are each measured, and need not add up to the total.
    expect(trace.timings).toEqual({
      embeddingMs: 5,
      semanticMs: expect.any(Number),
      lexicalMs: expect.any(Number),
      fusionMs: 5,
      contextMs: 5,
      totalMs: expect.any(Number),
    });
    expect(trace.counts).toEqual({ semantic: 1, lexical: 2, fused: 2, loaded: 2, selected: 2 });
    expect(trace.contextChars).toBe("cat one".length + "ECONNRESET two".length);
  });

  describe("concurrent candidate searches", () => {
    /** A store whose vector search stays pending until the test releases it. */
    function slowVectorSearch() {
      const calls: string[] = [];
      let release!: (matches: Awaited<ReturnType<VectorStore["searchSimilar"]>>) => void;
      let fail!: (error: Error) => void;
      const pending = new Promise<Awaited<ReturnType<VectorStore["searchSimilar"]>>>((resolve, reject) => {
        release = resolve;
        fail = reject;
      });
      const vectorStore: VectorStore = Object.assign(Object.create(stores.vectorStore) as VectorStore, {
        searchSimilar: () => {
          calls.push("semantic started");
          return pending;
        },
        searchLexical: async (search: LexicalSearch) => {
          calls.push("lexical started");
          return stores.vectorStore.searchLexical(search);
        },
      });
      return { vectorStore, calls, release, fail };
    }

    it("runs the full-text query while the vector scan is still in flight, and fuses both afterwards", async () => {
      await index("user-1", "doc-1", "ops.md", ["the cat sleeps", "Error ECONNRESET upstream"]);
      const { vectorStore, calls, release } = slowVectorSearch();

      const result = retrieve(createRetriever({}, vectorStore), "cat ECONNRESET");
      await vi.waitFor(() => expect(calls).toEqual(["semantic started", "lexical started"]));
      release([{ chunkId: "doc-1-0", documentId: "doc-1", chunkIndex: 0, score: 0.9 }]);

      const { chunks, trace } = await result;
      expect(chunks.map((chunk) => chunk.chunkId).sort()).toEqual(["doc-1-0", "doc-1-1"]);
      expect(trace.counts).toMatchObject({ semantic: 1, lexical: 2, fused: 2 });
    });

    it("a failing full-text query rejects the retrieval, and the scan that is still running leaves no unhandled rejection", async () => {
      await index("user-1", "doc-1", "ops.md", ["the cat sleeps"]);
      const { vectorStore, fail } = slowVectorSearch();
      vectorStore.searchLexical = async () => {
        throw new Error("fts failed");
      };

      const result = retrieve(createRetriever({}, vectorStore), "cat");
      await expect(result).rejects.toThrow("fts failed");
      fail(new Error("scan failed too")); // would crash the process (and fail this test run) if nobody observed it
      await new Promise((resolve) => setImmediate(resolve));
    });

    it("a failing vector scan rejects the retrieval", async () => {
      await index("user-1", "doc-1", "ops.md", ["the cat sleeps"]);
      const { vectorStore, fail } = slowVectorSearch();

      const result = retrieve(createRetriever({}, vectorStore), "cat");
      fail(new Error("scan failed"));

      await expect(result).rejects.toThrow("scan failed");
    });
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

  it("uses the configured RRF constant (default 60)", async () => {
    await index("user-1", "doc-1", "pets.md", ["the cat sleeps"]);

    const [defaults, tuned] = await Promise.all([
      retrieve(createRetriever(), "cat"),
      retrieve(createRetriever({ rrfK: 10 }), "cat"),
    ]);

    // Found by both methods at rank 1: 2 / (k + 1).
    expect(defaults.chunks[0].ranking.fusedScore).toBeCloseTo(2 / 61);
    expect(tuned.chunks[0].ranking.fusedScore).toBeCloseTo(2 / 11);
  });

  it("can run vector-only or keyword-only by emptying the other candidate list", async () => {
    await index("user-1", "doc-1", "ops.md", ["the cat sleeps", "Error ECONNRESET upstream"]);

    const vectorOnly = await retrieve(createRetriever({ lexicalLimit: 0 }), "cat ECONNRESET");
    const keywordOnly = await retrieve(createRetriever({ semanticLimit: 0 }), "cat ECONNRESET");

    expect(vectorOnly.chunks.map((chunk) => chunk.chunkId)).toEqual(["doc-1-0"]);
    expect(keywordOnly.chunks.map((chunk) => chunk.chunkId).sort()).toEqual(["doc-1-0", "doc-1-1"]);
    expect(keywordOnly.chunks.every((chunk) => chunk.ranking.semanticRank === undefined)).toBe(true);
  });

  it("exposes every ranked candidate, including those context selection dropped, for diagnostics", async () => {
    const same = "the cat sleeps on the sofa";
    await index("user-1", "doc-1", "a.md", [same]);
    await index("user-1", "doc-2", "b.md", [same]);

    const result = await retrieve(createRetriever(), "cat sofa");

    expect(result.candidates.map((chunk) => chunk.chunkId).sort()).toEqual(["doc-1-0", "doc-2-0"]);
    expect(result.chunks).toHaveLength(1); // the exact duplicate was skipped
    expect(result.candidates[0].content).toBe(same);
    expect(result.candidates.map((chunk) => chunk.ranking.fusedRank)).toEqual([1, 2]);
  });
});

describe("HybridRetriever confidence gate", () => {
  const policy = { minSemanticScore: 0.8, minTermCoverage: 0.9, requireKnownIdentifiers: true };

  it("without a policy every retrieval that found candidates is allowed through", async () => {
    await index("user-1", "doc-1", "pets.md", ["the cat sleeps"]);

    const result = await retrieve(createRetriever(), "cat");

    expect(result.confidence).toMatchObject({ decision: "answer" });
    expect(result.chunks).toHaveLength(1);
  });

  it("hands the model nothing when the evidence is weak, but still reports the candidates and the signals", async () => {
    await index("user-1", "doc-1", "pets.md", ["the cat sleeps on the sofa all day long and purrs"]);

    const result = await retrieve(createRetriever({ confidence: policy }), "cat tax space dog");

    expect(result.confidence).toMatchObject({ decision: "abstain", reason: "weak-evidence" });
    expect(result.chunks).toEqual([]);
    expect(result.trace.counts.selected).toBe(0);
    expect(result.trace.contextChars).toBe(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.signals.candidateCount).toBe(1);
  });

  it("passes strong evidence through", async () => {
    await index("user-1", "doc-1", "pets.md", ["the cat sleeps"]);

    const result = await retrieve(createRetriever({ confidence: { ...policy, minSemanticScore: 0.5 } }), "cat");

    expect(result.confidence).toMatchObject({ decision: "answer", reason: "semantic" });
    expect(result.chunks).toHaveLength(1);
  });

  it("abstains on nothing at all, without a reason that blames the policy", async () => {
    const result = await retrieve(createRetriever({ confidence: policy }), "cat?");

    expect(result.confidence).toMatchObject({ decision: "abstain", reason: "no-candidates" });
  });

  it("abstains when the question names an identifier that the user's documents do not contain", async () => {
    await index("user-1", "doc-1", "ops.md", ["the cat sleeps; ECONNRESET is raised by the proxy"]);

    const result = await retrieve(createRetriever({ confidence: { ...policy, minSemanticScore: 0.1 } }), "cat ECONNREFUSED");

    expect(result.confidence).toMatchObject({ decision: "abstain", reason: "identifier-not-found" });
    expect(result.chunks).toEqual([]);
  });

  it("never counts another user's evidence: the exact token and the strong match live in someone else's documents", async () => {
    await index("user-2", "doc-2", "ops.md", ["cat cat cat ECONNRESET ECONNRESET cat"]);
    await index("user-1", "doc-1", "other.md", ["tax rules and nothing else"]);

    const result = await retrieve(createRetriever({ confidence: { ...policy, minSemanticScore: 0.5 } }), "cat ECONNRESET");

    expect(result.confidence.decision).toBe("abstain");
    expect(result.signals).toMatchObject({ exactTargetsFound: 0, topSemanticScore: null });
    expect(result.candidates).toEqual([]);
  });

  it("ranks without selecting: rank() describes the evidence and loads candidates but builds no context", async () => {
    await index("user-1", "doc-1", "pets.md", ["the cat sleeps", "cat cat"]);

    const ranked = await createRetriever().rank({ userId: "user-1", question: "cat" });

    expect(ranked.candidates.map((chunk) => chunk.chunkId).sort()).toEqual(["doc-1-0", "doc-1-1"]);
    expect(ranked.signals.candidateCount).toBe(2);
    expect(ranked).not.toHaveProperty("chunks");
  });
});

describe("HybridRetriever exact-token bonus", () => {
  it("lifts the chunk that contains the identifier above chunks that merely sit close in meaning", async () => {
    await index("user-1", "doc-1", "docs.md", [
      "the cat sleeps",
      "cat cat cat cat cat", // semantically the closest
      "cat tax cat tax", // also found by both rankings
      "Error code E-4012 means low battery", // lexical only: no embedding keyword
    ]);

    const plain = await retrieve(createRetriever({ topK: 4 }), "cat E-4012");
    const boosted = await retrieve(createRetriever({ topK: 4, exactTokenBonus: 1 }), "cat E-4012");

    expect(plain.candidates.findIndex((chunk) => chunk.content.includes("E-4012"))).toBeGreaterThan(0);
    expect(boosted.candidates[0].content).toContain("E-4012");
    expect(boosted.candidates[0].ranking).toMatchObject({ fusedRank: 1, exactMatches: 1 });
  });

  it("does nothing when the question contains no identifier", async () => {
    await index("user-1", "doc-1", "docs.md", ["the cat sleeps", "cat cat cat", "Error code E-4012 means low battery"]);

    const plain = await retrieve(createRetriever(), "where is the cat");
    const boosted = await retrieve(createRetriever({ exactTokenBonus: 1 }), "where is the cat");

    expect(boosted.candidates.map((chunk) => chunk.chunkId)).toEqual(plain.candidates.map((chunk) => chunk.chunkId));
  });
});

describe("HybridRetriever weighted fusion", () => {
  it("lets the lexical ranking count more when weighted", async () => {
    await index("user-1", "doc-1", "docs.md", ["cat cat cat", "Error ECONNRESET upstream"]);

    const plain = await retrieve(createRetriever(), "cat ECONNRESET");
    const weighted = await retrieve(createRetriever({ lexicalWeight: 3 }), "cat ECONNRESET");

    expect(weighted.candidates[0].ranking.fusedScore).toBeGreaterThan(plain.candidates[0].ranking.fusedScore);
  });
});

describe("HybridRetriever: evidence is measured on the asking user's loaded chunks only", () => {
  it("ignores match lists that name chunks of another user (a store bug must not leak into confidence)", async () => {
    await index("user-2", "doc-2", "secret.md", ["cat cat cat ECONNRESET"]);
    await index("user-1", "doc-1", "mine.md", ["tax rules and nothing else"]);
    const [foreign] = await stores.vectorStore.searchLexical({ userId: "user-2", query: "ECONNRESET", limit: 5 });
    const leaky = Object.assign(Object.create(stores.vectorStore) as VectorStore, {
      searchLexical: async () => [foreign],
      searchSimilar: async () => [{ ...foreign, score: 0.99 }],
    });

    const result = await retrieve(createRetriever({ confidence: { minSemanticScore: 0.5, minTermCoverage: 0.6, requireKnownIdentifiers: true } }, leaky), "cat ECONNRESET");

    expect(result.candidates).toEqual([]);
    expect(result.signals).toMatchObject({ candidateCount: 0, semanticCount: 0, lexicalCount: 0, topSemanticScore: null, topLexicalScore: null, exactTargetsFound: 0 });
    expect(result.confidence).toMatchObject({ decision: "abstain", reason: "no-candidates" });
  });
});
