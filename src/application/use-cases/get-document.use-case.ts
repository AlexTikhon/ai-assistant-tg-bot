import { NotFoundError } from "../../shared/errors.js";
import { buildOverviews } from "../document-overview.js";
import type { DocumentOverview, OverviewDependencies } from "../document-overview.js";
import type { DocumentRepository } from "../ports/document-repository.js";

/** One of the user's documents with its index health (`/doc <id>`). Another user's document is "not found". */
export class GetDocumentUseCase {
  constructor(private readonly deps: OverviewDependencies & { documents: DocumentRepository }) {}

  async execute(userId: string, documentId: string): Promise<DocumentOverview> {
    const document = await this.deps.documents.findById(userId, documentId);
    if (!document) {
      throw new NotFoundError();
    }
    const [overview] = await buildOverviews(this.deps, userId, [document]);
    return overview;
  }
}
