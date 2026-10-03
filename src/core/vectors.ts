/** Raised when vectors cannot be compared or stored (bad shape, non-finite values, corrupted data). */
export class VectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorError";
  }
}

/** Throws unless the vector is non-empty and contains only finite numbers. */
export function assertValidVector(vector: readonly number[], label = "vector") {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new VectorError(`${label} is empty`);
  }

  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new VectorError(`${label} contains a non-finite value`);
    }
  }
}

/**
 * Cosine similarity in [-1, 1].
 *
 * Throws VectorError for empty vectors, non-finite values and dimension mismatches - comparing
 * vectors from different models is a bug, never "similarity 0". A vector with zero norm has no
 * direction, so it is defined as having similarity 0 with everything.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]) {
  assertValidVector(left, "left vector");
  assertValidVector(right, "right vector");

  if (left.length !== right.length) {
    throw new VectorError(`Dimension mismatch: ${left.length} vs ${right.length}`);
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  // Floating point error can push the result marginally outside [-1, 1].
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))));
}

/** Checks that a provider returned exactly one valid, equally sized vector per input. */
export function assertEmbeddingBatch(vectors: readonly number[][], expectedCount: number) {
  if (vectors.length !== expectedCount) {
    throw new VectorError(`Expected ${expectedCount} embeddings, received ${vectors.length}`);
  }

  vectors.forEach((vector, index) => assertValidVector(vector, `embedding #${index}`));

  const dimension = vectors[0]?.length;
  if (vectors.some((vector) => vector.length !== dimension)) {
    throw new VectorError("Embeddings have inconsistent dimensions");
  }
}
