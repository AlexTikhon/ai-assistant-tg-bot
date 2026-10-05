import { NotFoundError } from "../../shared/errors.js";
import { KeyedMutex } from "../../shared/keyed-mutex.js";
import { logger } from "../../shared/logger.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { FileStorage } from "../ports/file-storage.js";
import type { VectorStore } from "../ports/vector-store.js";
import { throwIfCancelled } from "../../shared/operation.js";

type Dependencies = {
  documents: DocumentRepository;
  vectorStore: VectorStore;
  files: FileStorage;
  /** Per-user serialization shared with ingestion and replacement. A private one by default. */
  locks?: KeyedMutex;
};

const log = logger.child({ operation: "deleteDocument" });

/**
 * Deletes a document the user owns.
 *
 * The database row is the source of truth: it is removed in a single operation (chunks go with it
 * via ON DELETE CASCADE). Cleaning up derived artifacts afterwards is best effort - a leftover file
 * is logged but never turns a completed deletion into an error for the user (`npm run integrity` reports it
 * as an orphan). The reverse order would be worse: a file deleted first and a failing database leaves a
 * document that cannot be rebuilt.
 *
 * It runs under the same per-user lock as ingestion and replacement, so it can never overlap a replacement
 * of the same document (which would otherwise orphan the file that replacement just wrote).
 */
export class DeleteDocumentUseCase {
  private readonly userLocks: KeyedMutex;

  constructor(private readonly deps: Dependencies) {
    this.userLocks = deps.locks ?? new KeyedMutex();
  }

  execute(userId: string, documentId: string): Promise<void> {
    return this.userLocks.run(userId, () => this.delete(userId, documentId));
  }

  private async delete(userId: string, documentId: string): Promise<void> {
    throwIfCancelled();
    const { documents, vectorStore, files } = this.deps;

    const document = await documents.findById(userId, documentId);
    if (!document || !(await documents.delete(userId, documentId))) {
      throw new NotFoundError();
    }

    await vectorStore
      .deleteByDocument(userId, documentId)
      .catch((err) => log.warn({ err, documentId }, "Failed to delete vectors after document removal"));
    await files
      .delete(document.storedName)
      .catch((err) => log.warn({ err, documentId, storedName: document.storedName }, "Failed to delete stored file"));

    log.info({ userId, documentId }, "Document deleted");
  }
}
