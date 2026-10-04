import type { WarnLog } from "../shared/logger.js";
import type { IndexMaintenance } from "./ports/index-maintenance.js";

export type IndexCompatibility = {
  staleDocuments: number;
  staleChunks: number;
};

/**
 * Startup diagnostic: counts chunks whose vector does not match the configured embeddings model (or
 * is unreadable) and logs one warning with the command that fixes it. Reads the database only - it
 * never calls the embeddings API, so it can never cost money. Stale chunks stay searchable by keyword.
 */
export async function checkIndexCompatibility(
  maintenance: IndexMaintenance,
  embeddingModel: string,
  log: WarnLog,
): Promise<IndexCompatibility> {
  const documents = await maintenance.listIndexedDocuments({ model: embeddingModel });
  const stale = documents.filter((document) => document.staleChunkCount > 0);
  const summary = {
    staleDocuments: stale.length,
    staleChunks: stale.reduce((sum, document) => sum + document.staleChunkCount, 0),
  };

  if (summary.staleChunks > 0) {
    log.warn(
      { embeddingModel, ...summary },
      "Some indexed chunks do not match the configured embeddings model; they are skipped by semantic search " +
        "until re-indexed. Run `npm run reindex` (add --dry-run to preview).",
    );
  }

  return summary;
}
