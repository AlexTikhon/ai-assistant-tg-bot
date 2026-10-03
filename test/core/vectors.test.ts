import { describe, expect, it } from "vitest";
import { assertEmbeddingBatch, cosineSimilarity, VectorError } from "../../src/core/vectors.js";

describe("cosineSimilarity", () => {
  it("is 1 for identical direction, 0 for orthogonal and -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1);
  });

  it("ignores vector magnitude", () => {
    expect(cosineSimilarity([1, 2, 3], [10, 20, 30])).toBeCloseTo(1);
  });

  it("throws on dimension mismatch instead of returning a misleading score", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(/Dimension mismatch/);
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(VectorError);
  });

  it("throws on zero-length vectors", () => {
    expect(() => cosineSimilarity([], [])).toThrow(VectorError);
    expect(() => cosineSimilarity([1], [])).toThrow(VectorError);
  });

  it("throws on non-finite values", () => {
    expect(() => cosineSimilarity([1, Number.NaN], [1, 2])).toThrow(/non-finite/);
    expect(() => cosineSimilarity([1, 2], [Number.POSITIVE_INFINITY, 2])).toThrow(/non-finite/);
  });

  it("defines the similarity with a zero-norm vector as 0 (never NaN)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it("stays within [-1, 1] despite floating point error", () => {
    const vector = [0.1, 0.2, 0.3, 0.4, 0.5, 0.123456789];
    const score = cosineSimilarity(vector, vector);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(-1);
  });
});

describe("assertEmbeddingBatch", () => {
  it("accepts one valid vector per input", () => {
    expect(() => assertEmbeddingBatch([[1, 2], [3, 4]], 2)).not.toThrow();
  });

  it("rejects a wrong number of vectors", () => {
    expect(() => assertEmbeddingBatch([[1, 2]], 2)).toThrow(/Expected 2 embeddings, received 1/);
  });

  it("rejects empty, non-finite and inconsistently sized vectors", () => {
    expect(() => assertEmbeddingBatch([[]], 1)).toThrow(VectorError);
    expect(() => assertEmbeddingBatch([[1, Number.NaN]], 1)).toThrow(VectorError);
    expect(() => assertEmbeddingBatch([[1, 2], [1, 2, 3]], 2)).toThrow(/inconsistent dimensions/);
  });
});
