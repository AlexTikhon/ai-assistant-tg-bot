import type { DocumentRecord } from "../core/document.js";
import type { IndexHealth } from "../core/index-health.js";
import { logger } from "../shared/logger.js";
import { assessDocument, healthOf } from "./assess-index.js";
import type { ActiveRecipe } from "./assess-index.js";
import type { FileStorage } from "./ports/file-storage.js";
import type { IndexMaintenance } from "./ports/index-maintenance.js";

/** A document as its owner sees it: the record plus how healthy its index is. */
export type DocumentOverview = {
  document: DocumentRecord;
  chunksCount: number;
  health: IndexHealth;
};

export type OverviewDependencies = {
  maintenance: IndexMaintenance;
  files: FileStorage;
  /** The recipe new uploads are indexed with; what "current" means. */
  recipe: Omit<ActiveRecipe, "embeddingDimension">;
};

const log = logger.child({ operation: "documentOverview" });

/**
 * Derives the health of the given documents of one user from their recorded profile, their chunks and the
 * file system. Reads only; never calls a provider. A storage that cannot be inspected leaves the file state
 * unreported (null) instead of failing the listing.
 */
export async function buildOverviews(
  deps: OverviewDependencies,
  userId: string,
  documents: DocumentRecord[],
): Promise<DocumentOverview[]> {
  const indexed = await deps.maintenance.listIndexedDocuments({ model: deps.recipe.embeddingModel }, { userId });
  const byId = new Map(indexed.map((item) => [item.documentId, item]));

  return Promise.all(
    documents.map(async (document): Promise<DocumentOverview> => {
      const entry = byId.get(document.id);
      const fileMissing = await deps.files
        .stat(document.storedName)
        .then((info) => info === null)
        .catch((err) => {
          log.warn({ err, documentId: document.id }, "Could not inspect the stored file");
          return null;
        });

      if (!entry) {
        // Cannot happen for a document that was just read, except when it was deleted in between.
        return { document, chunksCount: 0, health: { state: "unindexed", issues: ["unindexed"] } };
      }
      return { document, chunksCount: entry.chunkCount, health: healthOf(assessDocument(entry, deps.recipe), fileMissing) };
    }),
  );
}
