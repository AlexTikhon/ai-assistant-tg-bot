import { hashContent } from "../core/content-hash.js";
import type { DocumentRecord } from "../core/document.js";
import { logger } from "../shared/logger.js";
import type { DocumentRepository } from "./ports/document-repository.js";
import type { FileStorage } from "./ports/file-storage.js";

const log = logger.child({ operation: "findDocumentByContent" });

/**
 * The user's document with this content, or null. Only the user's own documents are ever consulted.
 *
 * Documents stored before hashes existed have none: those of the same size are hashed from their stored
 * original (once - the hash is persisted), so history is recognised without reading every file. A missing
 * or unreadable original simply leaves that document's hash unknown; it never fails the caller.
 */
export async function findDocumentByContent(
  deps: { documents: DocumentRepository; files: FileStorage },
  userId: string,
  contentHash: string,
  fileSize: number,
): Promise<DocumentRecord | null> {
  const { documents, files } = deps;

  const known = await documents.findByContentHash(userId, contentHash);
  if (known) {
    return known;
  }

  for (const candidate of await documents.findUnhashedBySize(userId, fileSize)) {
    let bytes: Buffer;
    try {
      bytes = await files.read(candidate.storedName);
    } catch (err) {
      log.warn({ err, documentId: candidate.id }, "Could not read a stored file to backfill its content hash");
      continue;
    }

    const candidateHash = hashContent(bytes);
    await documents.setContentHash(userId, candidate.id, candidateHash);
    if (candidateHash === contentHash) {
      return { ...candidate, contentHash };
    }
  }

  return null;
}
