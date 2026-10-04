import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashContent, isContentHash } from "../../src/core/content-hash.js";

describe("content identity", () => {
  it("is the SHA-256 of the original bytes", () => {
    const data = Buffer.from("The cat sleeps.");

    expect(hashContent(data)).toBe(createHash("sha256").update(data).digest("hex"));
  });

  it("is the same for identical bytes, whatever the file is called", () => {
    expect(hashContent(Buffer.from("same bytes"))).toBe(hashContent(Buffer.from("same bytes")));
  });

  it("differs for different bytes", () => {
    expect(hashContent(Buffer.from("version 1"))).not.toBe(hashContent(Buffer.from("version 2")));
  });

  it("hashes bytes, not decoded text: two encodings of the same text are different content", () => {
    expect(hashContent(Buffer.from("é", "utf-8"))).not.toBe(hashContent(Buffer.from("é", "latin1")));
  });

  it("recognises well-formed hashes only", () => {
    expect(isContentHash(hashContent(Buffer.from("x")))).toBe(true);
    expect(isContentHash("abc")).toBe(false);
    expect(isContentHash("Z".repeat(64))).toBe(false);
    expect(isContentHash(null)).toBe(false);
  });
});
