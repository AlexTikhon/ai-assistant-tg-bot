import type { StaleKind } from "./index-profile.js";

/**
 * What can be wrong with a document's index. Nothing here is stored: it is derived from the document's
 * recorded profile, its chunks and the file system, so it can never disagree with them.
 */
type HealthIssue =
  /** No chunks at all: nothing can be found in this document. */
  | "unindexed"
  /** Some stored vectors cannot be read (bad blob, dimension 0); the chunk text is still searchable by keyword. */
  | "corrupt-index"
  /** Vectors from another embedding model/dimension: skipped by semantic search, keyword search still works. */
  | "embedding-stale"
  /** Different chunk size/overlap/algorithm than configured: searchable, just not laid out as configured. */
  | "chunking-stale"
  /** Older text/page/section extraction: searchable, but newer citations (pages, sections) are missing. */
  | "extractor-stale"
  /** The original file is gone from storage: the index works, but it cannot be rebuilt from the file. */
  | "missing-file";

type IndexHealthState = "current" | HealthIssue;

export type IndexHealth = {
  /** The most serious issue, or "current". */
  state: IndexHealthState;
  /** Every issue that applies, most serious first. Empty when current. */
  issues: HealthIssue[];
};

export type HealthFacts = {
  chunkCount: number;
  /** Chunks whose vector cannot be decoded at all (not merely from another model). */
  unreadableChunkCount: number;
  /** Differences between the recorded index profile and the configured one. */
  stale: Record<StaleKind, boolean>;
  /** Whether the original file is missing from storage; null when that was not checked. */
  fileMissing: boolean | null;
};

/** Severity order. A document with no chunks has nothing that could be corrupt or stale. */
export function deriveIndexHealth(facts: HealthFacts): IndexHealth {
  const issues: HealthIssue[] = [];

  if (facts.chunkCount === 0) {
    issues.push("unindexed");
  } else {
    if (facts.unreadableChunkCount > 0) issues.push("corrupt-index");
    if (facts.stale.embedding) issues.push("embedding-stale");
    if (facts.stale.chunking) issues.push("chunking-stale");
    if (facts.stale.extractor) issues.push("extractor-stale");
  }
  if (facts.fileMissing === true) issues.push("missing-file");

  return { state: issues[0] ?? "current", issues };
}

/** Whether questions can find anything in the document (by keyword at least). */
export function isSearchable(health: IndexHealth): boolean {
  return !health.issues.includes("unindexed");
}
