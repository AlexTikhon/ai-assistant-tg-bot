import os from "node:os";
import { describe, expect, it } from "vitest";
import { cosineSimilarity, decodeVector, decodeVectorPortable, encodeVector, VectorError } from "../../src/core/vectors.js";

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

describe("explicit little-endian vector format", () => {
  it("writes IEEE-754 float32 little-endian bytes regardless of the host", () => {
    // 1.0 = 0x3f800000, -2.0 = 0xc0000000, 0.5 = 0x3f000000 -> least significant byte first.
    expect([...encodeVector([1, -2, 0.5])]).toEqual([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x3f]);
  });

  it("round-trips normal, negative, zero and extreme finite values", () => {
    const values = [0, -0, 0.1, -3.5, 123456.78, 1e-30, -1e30, 3.4028234663852886e38];
    const decoded = decodeVector(encodeVector(values));

    expect(decoded.length).toBe(values.length);
    values.forEach((value, index) => expect(decoded[index]).toBe(Math.fround(value)));
  });

  it("rejects NaN and both infinities, also those created by float32 overflow", () => {
    expect(() => encodeVector([1, Number.NaN])).toThrow(VectorError);
    expect(() => encodeVector([Number.POSITIVE_INFINITY])).toThrow(VectorError);
    expect(() => encodeVector([Number.NEGATIVE_INFINITY])).toThrow(VectorError);
    // 1e39 is a finite double but does not fit into float32.
    expect(() => encodeVector([1e39])).toThrow(/non-finite/);
  });

  it("validates the expected dimension when asked to", () => {
    const blob = encodeVector([1, 2, 3]);

    expect(decodeVector(blob, 3).length).toBe(3);
    expect(() => decodeVector(blob, 4)).toThrow(/dimension/i);
  });

  it("the portable decoder agrees with the fast path (so big-endian hosts read the same bytes)", () => {
    const blob = encodeVector([0.25, -1.5, 3, 1e-8]);

    expect([...decodeVectorPortable(blob)]).toEqual([...decodeVector(blob)]);
  });

  it("still reads vectors stored by the previous native-order encoder (little-endian on every supported host)", () => {
    const legacyBlob = Buffer.from(new Float32Array([0.25, -1.5, 3]).buffer);

    expect(os.endianness()).toBe("LE");
    expect([...decodeVector(legacyBlob)]).toEqual([0.25, -1.5, 3]);
    expect(encodeVector([0.25, -1.5, 3]).equals(legacyBlob)).toBe(true);
  });
});
