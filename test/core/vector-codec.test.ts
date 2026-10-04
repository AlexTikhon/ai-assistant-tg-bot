import { describe, expect, it } from "vitest";
import { cosineSimilarity, decodeVector, encodeVector, VectorError } from "../../src/core/vectors.js";

describe("vector BLOB codec", () => {
  it("round-trips a vector as 4 bytes per dimension (float32 precision)", () => {
    const blob = encodeVector([0.25, -1.5, 3]);

    expect(blob.byteLength).toBe(12);
    expect(Array.from(decodeVector(blob))).toEqual([0.25, -1.5, 3]);
  });

  it("decodes a Buffer that is not aligned to 4 bytes (as returned by SQLite)", () => {
    const padded = Buffer.concat([Buffer.from([9]), encodeVector([1, 2])]);

    expect(Array.from(decodeVector(padded.subarray(1)))).toEqual([1, 2]);
  });

  it("refuses to encode empty or non-finite vectors", () => {
    expect(() => encodeVector([])).toThrow(VectorError);
    expect(() => encodeVector([1, Number.NaN])).toThrow(/non-finite/);
  });

  it("refuses to decode blobs whose size is not a multiple of 4 or that hold non-finite values", () => {
    expect(() => decodeVector(Buffer.from([1, 2, 3]))).toThrow(VectorError);
    expect(() => decodeVector(Buffer.alloc(0))).toThrow(VectorError);
    expect(() => decodeVector(Buffer.from(new Float32Array([1, Number.NaN]).buffer))).toThrow(/non-finite/);
  });

  it("decoded vectors can be compared directly with cosineSimilarity", () => {
    expect(cosineSimilarity([1, 0], decodeVector(encodeVector([2, 0])))).toBeCloseTo(1);
  });
});
