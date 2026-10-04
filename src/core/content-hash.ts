import { createHash } from "node:crypto";

/**
 * Content identity of an uploaded file: the SHA-256 of its original bytes, as lower-case hex.
 *
 * It identifies *content* only. It is never an authorization: every lookup that uses a hash is also
 * scoped to the owning user, and a hash is never shown to a normal user.
 */
export function hashContent(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

const CONTENT_HASH = /^[0-9a-f]{64}$/;

/** Whether a stored value is a well-formed content hash (null/garbage means "unknown"). */
export function isContentHash(value: unknown): value is string {
  return typeof value === "string" && CONTENT_HASH.test(value);
}
