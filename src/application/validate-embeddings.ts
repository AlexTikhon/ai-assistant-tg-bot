import { assertEmbeddingBatch, assertValidVector, VectorError } from "../core/vectors.js";
import { ExternalServiceError } from "../shared/errors.js";

/** A provider that returns malformed vectors is treated like any other provider failure. */
function asProviderError(error: unknown) {
  return error instanceof VectorError
    ? new ExternalServiceError("embeddings", { cause: error })
    : error;
}

/** Ensures a document batch has one valid vector per input, all with the same dimension. */
export function ensureEmbeddingBatch(vectors: number[][], expectedCount: number) {
  try {
    assertEmbeddingBatch(vectors, expectedCount);
  } catch (error) {
    throw asProviderError(error);
  }
}

/** Ensures a query vector is usable for similarity search. */
export function ensureQueryEmbedding(vector: number[]) {
  try {
    assertValidVector(vector, "query embedding");
  } catch (error) {
    throw asProviderError(error);
  }
}
