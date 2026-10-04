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

/** True on x86, ARM and every other platform this project supports; only then can a Float32Array view the blob directly. */
const HOST_IS_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Vector BLOB format (documented, platform independent): the IEEE-754 binary32 value of every
 * dimension, 4 bytes each, **little-endian**, no header. The dimension is stored in its own column.
 *
 * Earlier versions wrote the host's native byte order; on every supported (little-endian) host that is
 * byte-for-byte this format, so existing databases need no conversion.
 *
 * Values that do not fit into float32 (a finite double above ~3.4e38) would silently become Infinity,
 * so they are rejected like NaN and Infinity.
 */
export function encodeVector(vector: readonly number[]): Buffer {
  assertValidVector(vector, "embedding");

  const narrowed = new Float32Array(vector);
  assertValidVector(narrowed, "embedding");

  const blob = Buffer.alloc(narrowed.length * BYTES_PER_DIMENSION);
  for (let index = 0; index < narrowed.length; index += 1) {
    blob.writeFloatLE(narrowed[index], index * BYTES_PER_DIMENSION);
  }
  return blob;
}

/** Reads the little-endian format byte by byte; correct on any host. Exported for tests and as the reference. */
export function decodeVectorPortable(blob: Uint8Array): Float32Array {
  assertBlobShape(blob);

  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const vector = new Float32Array(blob.byteLength / BYTES_PER_DIMENSION);
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = view.getFloat32(index * BYTES_PER_DIMENSION, true);
  }
  return vector;
}

function assertBlobShape(blob: Uint8Array) {
  if (blob.byteLength === 0 || blob.byteLength % BYTES_PER_DIMENSION !== 0) {
    throw new VectorError(`Stored embedding has an invalid size (${blob.byteLength} bytes)`);
  }
}

/**
 * Inverse of `encodeVector`. Throws VectorError for blobs that are empty, misaligned, non-finite or
 * (when `expectedDimension` is given) of another dimension. This is the hot path of semantic search,
 * so little-endian hosts reinterpret the bytes instead of converting every value.
 */
export function decodeVector(blob: Uint8Array, expectedDimension?: number): Float32Array {
  assertBlobShape(blob);

  const dimension = blob.byteLength / BYTES_PER_DIMENSION;
  if (expectedDimension !== undefined && dimension !== expectedDimension) {
    throw new VectorError(`Stored embedding has dimension ${dimension}, expected ${expectedDimension}`);
  }

  // Copy: the Buffer SQLite hands out is generally not 4-byte aligned, which Float32Array requires.
  const vector = HOST_IS_LITTLE_ENDIAN
    ? new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength))
    : decodeVectorPortable(blob);
  assertValidVector(vector, "stored embedding");
  return vector;
}
