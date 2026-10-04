import type { DocumentRecord } from "../core/document.js";
import { logger } from "../shared/logger.js";
import type { DocumentRepository } from "./ports/document-repository.js";
import type { FileStorage } from "./ports/file-storage.js";

const log = logger.child({ operation: "restoreOriginal" });

/**
 * When a user sends the very bytes of a document whose original file has disappeared from storage, writes the
 * file again and points the document at it - no extraction, no embedding, no change to the index, the version or
 * the content identity (the bytes are the ones the document was indexed from: the caller found it by their hash).
 *
 * Best effort and never an error for the user: a storage that cannot be inspected counts as "nothing to
 * restore", and a failed write or update leaves the document exactly as it was (a file written in vain is removed
 * again). Returns whether the original was restored.
 */
export async function restoreMissingOriginal(
  deps: { documents: DocumentRepository; files: FileStorage },
  document: DocumentRecord,
  data: Buffer,
): Promise<boolean> {
  const { documents, files } = deps;

  const present = await files.stat(document.storedName).catch(() => undefined);
  if (present !== null) {
    return false; // there (or cannot be told): leave it
  }

  let storedName: string;
  try {
    storedName = await files.save(document.fileName, data);
  } catch (err) {
    log.warn({ err, documentId: document.id }, "Could not write the missing original again");
    return false;
  }

  try {
    if (!(await documents.updateStoredName(document.userId, document.id, storedName))) {
      throw new Error("the document no longer exists");
    }
  } catch (err) {
    log.warn({ err, documentId: document.id }, "Could not point the document at its restored original");
    await files.delete(storedName).catch((cleanupError) => log.warn({ err: cleanupError, storedName }, "Failed to remove the restored file again"));
    return false;
  }

  log.info({ userId: document.userId, documentId: document.id }, "Missing original file restored from a duplicate upload");
  return true;
}
