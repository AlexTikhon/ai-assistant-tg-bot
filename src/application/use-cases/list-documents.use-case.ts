import type { DocumentRecord } from "../../core/document.js";
import type { DocumentRepository } from "../ports/document-repository.js";

/** Returns the user's documents, newest first. */
export class ListDocumentsUseCase {
  constructor(private readonly deps: { documents: DocumentRepository }) {}

  execute(userId: string): Promise<DocumentRecord[]> {
    return this.deps.documents.listByUser(userId);
  }
}
