import type { WarnLog } from "../shared/logger.js";
import { assessDocument, summarizeAssessments } from "./assess-index.js";
import type { ActiveRecipe } from "./assess-index.js";
import type { IndexMaintenance } from "./ports/index-maintenance.js";

export type IndexCompatibility = {
  /** Documents (and chunks) whose stored vectors cannot be compared with the configured embeddings model. */
  staleDocuments: number;
  staleChunks: number;
  /** Documents per kind of staleness; see `npm run reindex -- --dry-run` for the reasons. */
  embeddingStale: number;
  chunkingStale: number;
  extractorStale: number;
};

/**
 * Startup diagnostic: compares every document's recorded index recipe with the configured one and logs
 * one warning with the commands that fix it. Reads the database only - it never calls the embeddings
 * API, so it can never cost money, and it never changes anything. Documents with outdated embeddings
 * stay searchable by keyword; chunk-layout and extraction differences do not affect search at all.
 */
export async function checkIndexCompatibility(
  maintenance: IndexMaintenance,
  recipe: Omit<ActiveRecipe, "embeddingDimension">,
  log: WarnLog,
): Promise<IndexCompatibility> {
  const documents = await maintenance.listIndexedDocuments({ model: recipe.embeddingModel });
  const summary = summarizeAssessments(documents.map((document) => assessDocument(document, recipe)));
  const withStaleVectors = documents.filter((document) => document.staleChunkCount > 0);

  const result: IndexCompatibility = {
    staleDocuments: withStaleVectors.length,
    staleChunks: withStaleVectors.reduce((sum, document) => sum + document.staleChunkCount, 0),
    embeddingStale: summary.embedding,
    chunkingStale: summary.chunking,
    extractorStale: summary.extractor,
  };

  if (result.embeddingStale + result.chunkingStale + result.extractorStale > 0) {
    log.warn(
      { embeddingModel: recipe.embeddingModel, chunkSize: recipe.chunkSize, chunkOverlap: recipe.chunkOverlap, ...result },
      "Some documents were indexed with a different recipe than the configured one. Outdated embeddings are " +
        "skipped by semantic search until re-indexed (`npm run reindex`); a different chunk layout or extraction " +
        "(e.g. PDFs without page numbers, Markdown without sections) is rebuilt from the original files with `npm run reindex -- --rechunk`. " +
        "Add --dry-run to see why each document is stale.",
    );
  }

  return result;
}
