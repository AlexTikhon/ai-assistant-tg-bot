import type Database from "better-sqlite3";
import { ValidationError } from "../../shared/errors.js";

/** Rechecked in the publishing transaction, so another process cannot race a quota check. */
export function assertUserChunkLimit(db: Database.Database, userId: string, incoming: number, limit?: number, replacingId?: string) {
  if (limit === undefined) return;
  const existing = db.prepare<[string, string | null, string | null], { count: number }>(
    "SELECT COUNT(*) AS count FROM document_chunks WHERE user_id = ? AND (? IS NULL OR document_id != ?)",
  ).get(userId, replacingId ?? null, replacingId ?? null)?.count ?? 0;
  if (existing + incoming > limit) {
    throw new ValidationError(`This file would exceed your total chunk limit of ${limit}. Delete a document or split the file.`);
  }
}
