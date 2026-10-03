import { NotFoundError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { FileStorage } from "../ports/file-storage.js";
import type { VectorStore } from "../ports/vector-store.js";

type Dependencies = {
  documents: DocumentRepository;
  vectorStore: VectorStore;
  files: FileStorage;
};

const log = logger.child({ operation: "deleteDocument" });

/**
 * Deletes a document the user owns.
 *
 * The database row is the source of truth: it is removed in a single operation (chunks go with it
 * via ON DELETE CASCADE). Cleaning up derived artifacts afterwards is best effort - a leftover file
 * is logged but never turns a completed deletion into an error for the user.
 */
export class DeleteDocumentUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(userId: string, documentId: string): Promise<void> {
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
