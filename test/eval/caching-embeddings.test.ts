import { describe, expect, it } from "vitest";
import { CachingEmbeddings } from "../../src/eval/caching-embeddings.js";
import { KeywordEmbeddings } from "../support/fakes.js";

describe("CachingEmbeddings", () => {
  it("sends each distinct text to the provider once, however often it is asked for", async () => {
    const inner = new KeywordEmbeddings();
    const cache = new CachingEmbeddings(inner);

    const first = await cache.embedDocuments(["the cat", "the dog", "the cat"]);
    const second = await cache.embedDocuments(["the dog", "a new cat text"]);

    expect(first[0]).toEqual(first[2]);
    expect(second[0]).toEqual(first[1]);
    expect(inner.documentCalls).toEqual([["the cat", "the dog"], ["a new cat text"]]);
    expect(cache.providerCalls).toBe(3);
  });

  it("caches queries separately from documents and keeps the model name", async () => {
    const inner = new KeywordEmbeddings(["cat"], "some-model");
    const cache = new CachingEmbeddings(inner);

    await cache.embedQuery("cat");
    await cache.embedQuery("cat");
    await cache.embedDocuments(["cat"]);

    expect(inner.queryCalls).toEqual(["cat"]);
    expect(inner.documentCalls).toEqual([["cat"]]);
    expect(cache.model).toBe("some-model");
  });
});
