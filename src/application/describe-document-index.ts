import { deriveIndexHealth } from "../core/index-health.js";
import type { IndexHealth } from "../core/index-health.js";
import type { DocumentRecord } from "../core/document.js";
import {
  CHUNKING_ALGORITHM_VERSION,
  describeStaleness,
  diffIndexProfiles,
  extractorVersionFor,
  legacyIndexProfile,
} from "../core/index-profile.js";
import type { DocumentRepository } from "./ports/document-repository.js";

export type DescribedIndex = { chunksCount: number; health: IndexHealth };

/**
 * How an existing document's index relates to the recipe that new uploads would get - from the document's
 * recorded profile and its chunk count only (no file system, no provider call). A document indexed before
 * profiles were recorded is judged on what is known: its extractor generation. The embedding dimension is
 * not compared here (the provider has not been asked), `npm run integrity` does the deep check.
 */
export async function describeDocumentIndex(
  documents: Pick<DocumentRepository, "countChunks">,
  active: { embeddingModel: string; chunkSize: number; chunkOverlap: number },
  document: DocumentRecord,
): Promise<DescribedIndex> {
  const chunksCount = await documents.countChunks(document.userId, document.id);
  const stored = document.indexProfile ?? legacyIndexProfile(document.fileName, active.embeddingModel, 0);

  const reasons = diffIndexProfiles(stored, {
    embeddingModel: active.embeddingModel,
    chunkSize: active.chunkSize,
    chunkOverlap: active.chunkOverlap,
    chunkingVersion: CHUNKING_ALGORITHM_VERSION,
    extractorVersion: extractorVersionFor(document.fileName),
  });

  return {
    chunksCount,
    health: deriveIndexHealth({
      chunkCount: chunksCount,
      unreadableChunkCount: 0,
      stale: describeStaleness(reasons),
      fileMissing: null,
    }),
  };
}
