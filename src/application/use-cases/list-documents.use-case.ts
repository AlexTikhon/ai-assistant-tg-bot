import { buildOverviews } from "../document-overview.js";
import type { DocumentOverview, OverviewDependencies } from "../document-overview.js";
import type { DocumentRepository } from "../ports/document-repository.js";

/** Returns the user's documents, newest first, each with the health of its index. */
export class ListDocumentsUseCase {
  constructor(private readonly deps: OverviewDependencies & { documents: DocumentRepository }) {}

  async execute(userId: string): Promise<DocumentOverview[]> {
    return buildOverviews(this.deps, userId, await this.deps.documents.listByUser(userId));
  }
}
