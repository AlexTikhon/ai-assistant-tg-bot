import { createHash } from "node:crypto";
import { getFileExtension } from "../shared/utils/path.js";

/**
 * Bump when `splitText` produces different chunks for the same text and options. Documents indexed
 * with an older algorithm are then reported as chunking-stale.
 */
export const CHUNKING_ALGORITHM_VERSION = 1;

/** Extraction recipes per file kind. Bump the one whose output (text or page/section information) changes. */
export const TEXT_EXTRACTOR_VERSION = "text-v1";
/** Markdown: the same text as plain text, plus the heading hierarchy (section path) of every chunk. */
export const MARKDOWN_EXTRACTOR_VERSION = "markdown-sections-v1";
/** PDF text with per-page provenance and without pdf-parse's "-- n of m --" page markers. */
export const PDF_EXTRACTOR_VERSION = "pdf-pages-v2";
/** What PDFs were indexed with before pages were tracked; only ever read from legacy rows. */
export const LEGACY_PDF_EXTRACTOR_VERSION = "pdf-v1";

export function extractorVersionFor(fileName: string) {
  switch (getFileExtension(fileName)) {
    case ".pdf":
      return PDF_EXTRACTOR_VERSION;
    case ".md":
      return MARKDOWN_EXTRACTOR_VERSION;
    default:
      return TEXT_EXTRACTOR_VERSION;
  }
}

/**
 * Everything that shapes the persisted index of one document - and nothing else. Query-time
 * settings (top-k, RRF k, candidate limits, similarity threshold, context budget) are deliberately
 * absent: they can change at any time without making stored data stale.
 */
export type IndexProfile = {
  embeddingModel: string;
  embeddingDimension: number;
  chunkSize: number;
  chunkOverlap: number;
  chunkingVersion: number;
  extractorVersion: string;
};

/**
 * What is known about an already indexed document. `chunkSize` / `chunkOverlap` are null for documents
 * indexed before profiles were recorded: they are unknown, and unknown is never reported as a change.
 */
export type StoredIndexProfile = Omit<IndexProfile, "chunkSize" | "chunkOverlap"> & {
  chunkSize: number | null;
  chunkOverlap: number | null;
};

/**
 * What a document indexed before profiles were recorded is known to have: its vectors (read from the
 * chunks by the caller), the chunking algorithm that has existed since the beginning, and the PDF
 * extraction that preceded page tracking. Chunk size and overlap were never stored, so they stay unknown.
 */
export function legacyIndexProfile(fileName: string, embeddingModel: string, embeddingDimension: number): StoredIndexProfile {
  return {
    embeddingModel,
    embeddingDimension,
    chunkSize: null,
    chunkOverlap: null,
    chunkingVersion: CHUNKING_ALGORITHM_VERSION,
    extractorVersion: getFileExtension(fileName) === ".pdf" ? LEGACY_PDF_EXTRACTOR_VERSION : TEXT_EXTRACTOR_VERSION,
  };
}

/** The profile new data would get. The dimension is unknown until the provider has been asked. */
export type ActiveIndexProfile = Omit<IndexProfile, "embeddingDimension"> & { embeddingDimension?: number };

export type BuildProfileInput = {
  fileName: string;
  embeddingModel: string;
  embeddingDimension: number;
  chunkSize: number;
  chunkOverlap: number;
};

export function buildIndexProfile(input: BuildProfileInput): IndexProfile {
  return {
    embeddingModel: input.embeddingModel,
    embeddingDimension: input.embeddingDimension,
    chunkSize: input.chunkSize,
    chunkOverlap: input.chunkOverlap,
    chunkingVersion: CHUNKING_ALGORITHM_VERSION,
    extractorVersion: extractorVersionFor(input.fileName),
  };
}

/**
 * Stable short identity of a profile: a hash of its fields in a fixed order. Equal fingerprints mean
 * equal recipes; it is for display and grouping, staleness itself is decided field by field so it
 * can say *why*.
 */
export function indexFingerprint(profile: StoredIndexProfile): string {
  const canonical = JSON.stringify([
    profile.embeddingModel,
    profile.embeddingDimension,
    profile.chunkSize,
    profile.chunkOverlap,
    profile.chunkingVersion,
    profile.extractorVersion,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

export type StaleKind = "embedding" | "chunking" | "extractor";

export type StaleReason = {
  kind: StaleKind;
  /** The profile field that differs; "vectors" is for stored vectors that are unreadable although the recipe matches. */
  field: keyof IndexProfile | "vectors";
  from: string | number | null;
  to: string | number;
};

/** Field -> which part of the pipeline a difference belongs to. Order is the reporting order. */
const FIELD_KIND: ReadonlyArray<[keyof IndexProfile, StaleKind]> = [
  ["embeddingModel", "embedding"],
  ["embeddingDimension", "embedding"],
  ["chunkSize", "chunking"],
  ["chunkOverlap", "chunking"],
  ["chunkingVersion", "chunking"],
  ["extractorVersion", "extractor"],
];

/**
 * Differences between what a document was indexed with and what would be used now. Empty means the
 * document is current. Fields that were never recorded (null) or are not known yet (undefined) are
 * skipped rather than guessed.
 */
export function diffIndexProfiles(stored: StoredIndexProfile, active: ActiveIndexProfile): StaleReason[] {
  return FIELD_KIND.flatMap(([field, kind]): StaleReason[] => {
    const from = stored[field];
    const to = active[field];
    return from === null || to === undefined || from === to ? [] : [{ kind, field, from, to }];
  });
}

export function describeStaleness(reasons: readonly StaleReason[]): Record<StaleKind, boolean> {
  return {
    embedding: reasons.some((reason) => reason.kind === "embedding"),
    chunking: reasons.some((reason) => reason.kind === "chunking"),
    extractor: reasons.some((reason) => reason.kind === "extractor"),
  };
}
