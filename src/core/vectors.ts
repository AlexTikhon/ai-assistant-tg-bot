/** Raised when vectors cannot be compared or stored (bad shape, non-finite values, corrupted data). */
export class VectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorError";
  }
}

/** Throws unless the vector is non-empty and contains only finite numbers. */
export function assertValidVector(vector: ArrayLike<number>, label = "vector") {
  if (typeof vector?.length !== "number" || vector.length === 0) {
    throw new VectorError(`${label} is empty`);
  }

  for (let index = 0; index < vector.length; index += 1) {
    if (!Number.isFinite(vector[index])) {
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
export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>) {
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

const BYTES_PER_DIMENSION = Float32Array.BYTES_PER_ELEMENT;

/**
 * Serializes a vector as a float32 BLOB (native byte order, 4 bytes per dimension). That is the
 * precision embedding providers return anyway, and it is ~5x smaller and much faster to read than JSON.
 */
export function encodeVector(vector: readonly number[]): Buffer {
  assertValidVector(vector, "embedding");
  return Buffer.from(new Float32Array(vector).buffer);
}

/** Inverse of `encodeVector`. Throws VectorError for blobs that are empty, misaligned or non-finite. */
export function decodeVector(blob: Uint8Array): Float32Array {
  if (blob.byteLength === 0 || blob.byteLength % BYTES_PER_DIMENSION !== 0) {
    throw new VectorError(`Stored embedding has an invalid size (${blob.byteLength} bytes)`);
  }

  // Copy: the Buffer SQLite hands out is generally not 4-byte aligned, which Float32Array requires.
  const vector = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  assertValidVector(vector, "stored embedding");
  return vector;
}
