import { describe, expect, it } from "vitest";
import { countEmbeddingRequests, embeddingBatchSize, MAX_EMBEDDING_BATCH_SIZE } from "../../src/core/embedding-batches.js";

describe("embeddingBatchSize", () => {
  it("never exceeds the provider's maximum number of inputs per request", () => {
    expect(embeddingBatchSize(1)).toBe(MAX_EMBEDDING_BATCH_SIZE);
    expect(embeddingBatchSize(100)).toBe(MAX_EMBEDDING_BATCH_SIZE);
  });

  it("shrinks as chunks grow so one request stays under the token cap even if every character were a token", () => {
    expect(embeddingBatchSize(1000)).toBe(250);
    expect(embeddingBatchSize(4000)).toBe(62);
    expect(embeddingBatchSize(1000) * 1000).toBeLessThanOrEqual(250_000);
    expect(embeddingBatchSize(4000) * 4000).toBeLessThanOrEqual(250_000);
  });

  it("is at least one input per request, whatever the chunk size", () => {
    expect(embeddingBatchSize(1_000_000)).toBe(1);
    expect(embeddingBatchSize(0)).toBe(MAX_EMBEDDING_BATCH_SIZE);
  });
});

describe("countEmbeddingRequests", () => {
  it("is the number of batches the provider will be asked for", () => {
    expect(countEmbeddingRequests(0, 250)).toBe(0);
    expect(countEmbeddingRequests(1, 250)).toBe(1);
    expect(countEmbeddingRequests(250, 250)).toBe(1);
    expect(countEmbeddingRequests(251, 250)).toBe(2);
    expect(countEmbeddingRequests(2000, 250)).toBe(8);
  });

  it("without a known batch size everything counts as one request", () => {
    expect(countEmbeddingRequests(40, undefined)).toBe(1);
  });
});
