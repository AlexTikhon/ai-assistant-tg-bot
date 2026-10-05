import type Database from "better-sqlite3";
import type { IndexRevision } from "../../application/ports/document-repository.js";
import { IndexChangedError, NotFoundError } from "../../shared/errors.js";

/** Call inside the publishing transaction, before its first write. */
export function assertIndexRevision(db: Database.Database, userId: string, documentId: string, expected?: IndexRevision) {
  if (!expected) return;
  const current = db.prepare<[string, string], IndexRevision>(
    "SELECT document_version AS documentVersion, index_revision AS indexRevision FROM documents WHERE user_id = ? AND id = ?",
  ).get(userId, documentId);
  if (!current) throw new NotFoundError();
  if (current.documentVersion !== expected.documentVersion || current.indexRevision !== expected.indexRevision) {
    throw new IndexChangedError();
  }
}
