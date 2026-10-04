import {
  CHUNKING_ALGORITHM_VERSION,
  describeStaleness,
  diffIndexProfiles,
  extractorVersionFor,
  indexFingerprint,
} from "../core/index-profile.js";
import { deriveIndexHealth } from "../core/index-health.js";
import type { IndexHealth } from "../core/index-health.js";
import type { StaleKind, StaleReason } from "../core/index-profile.js";
import type { IndexedDocument } from "./ports/index-maintenance.js";

/** The recipe new data would be indexed with. The dimension is only known after asking the provider. */
export type ActiveRecipe = {
  embeddingModel: string;
  embeddingDimension?: number;
  chunkSize: number;
  chunkOverlap: number;
};

export type DocumentAssessment = IndexedDocument & {
  /** Why the document differs from the active recipe; empty when it is current. */
  reasons: StaleReason[];
  stale: Record<StaleKind, boolean>;
  /** Indexed before chunk size/overlap were recorded: cannot be judged, and is not reported as stale. */
  unknownChunkLayout: boolean;
  /** Identity of the recipe the document was actually indexed with. */
  fingerprint: string;
};

export type IndexSummary = {
  checked: number;
  /** Documents per kind of staleness (a document can be stale in several ways). */
  embedding: number;
  chunking: number;
  extractor: number;
  unknownChunkLayout: number;
};

/**
 * Compares one document's recorded recipe with the active one - field by field, so the answer is a list
 * of reasons and not just a flag - and adds unreadable vectors, which the recipe cannot show.
 */
export function assessDocument(document: IndexedDocument, active: ActiveRecipe): DocumentAssessment {
  const reasons = diffIndexProfiles(document.storedProfile, {
    embeddingModel: active.embeddingModel,
    embeddingDimension: active.embeddingDimension,
    chunkSize: active.chunkSize,
    chunkOverlap: active.chunkOverlap,
    chunkingVersion: CHUNKING_ALGORITHM_VERSION,
    extractorVersion: extractorVersionFor(document.fileName),
  });

  const explainedByRecipe = reasons.some((reason) => reason.kind === "embedding");
  if (document.staleChunkCount > 0 && !explainedByRecipe) {
    reasons.unshift({
      kind: "embedding",
      field: "vectors",
      from: `${document.staleChunkCount} of ${document.chunkCount} unreadable`,
      to: "readable",
    });
  }

  return {
    ...document,
    reasons,
    stale: describeStaleness(reasons),
    unknownChunkLayout: document.storedProfile.chunkSize === null || document.storedProfile.chunkOverlap === null,
    fingerprint: indexFingerprint(document.storedProfile),
  };
}

/**
 * The document's index health. Unreadable vectors are reported as corruption only (the "vectors" reason that
 * assessDocument adds for them is not also counted as a stale embedding recipe). `fileMissing` comes from
 * the file system; null when it was not checked.
 */
export function healthOf(assessment: DocumentAssessment, fileMissing: boolean | null): IndexHealth {
  return deriveIndexHealth({
    chunkCount: assessment.chunkCount,
    unreadableChunkCount: assessment.unreadableChunkCount,
    stale: describeStaleness(assessment.reasons.filter((reason) => reason.field !== "vectors")),
    fileMissing,
  });
}

export function summarizeAssessments(assessments: readonly DocumentAssessment[]): IndexSummary {
  return {
    checked: assessments.length,
    embedding: assessments.filter((item) => item.stale.embedding).length,
    chunking: assessments.filter((item) => item.stale.chunking).length,
    extractor: assessments.filter((item) => item.stale.extractor).length,
    unknownChunkLayout: assessments.filter((item) => item.unknownChunkLayout).length,
  };
}
