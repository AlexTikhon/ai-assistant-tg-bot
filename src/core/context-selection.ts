import { boundaryOverlap } from "./chunk-overlap.js";
import type { RetrievedChunk } from "./retrieval.js";
import { truncateText } from "../shared/utils/text.js";

export type ContextBudget = {
  /** Hard limit on the number of chunks. */
  maxChunks: number;
  /** Approximate budget: the summed length of the chunk texts. */
  maxChars: number;
  /** Soft cap per document; unused slots are backfilled so a single-document library is not starved. */
  maxPerDocument: number;
};

export type SkipReason = "duplicate" | "overlap" | "document-cap" | "budget";

export type ContextSelection = {
  /** Chosen chunks in relevance order. */
  selected: RetrievedChunk[];
  skipped: Array<{ chunkId: string; reason: SkipReason }>;
};

/** A neighbour is redundant when more than this share of its shorter side repeats the other chunk. */
const MAX_OVERLAP_RATIO = 0.5;

function normalize(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Why `candidate` adds (almost) nothing to what is already selected, if it does not. */
function redundancy(candidate: RetrievedChunk, selected: readonly RetrievedChunk[]): "duplicate" | "overlap" | null {
  const text = normalize(candidate.content);

  for (const other of selected) {
    if (normalize(other.content) === text) {
      return "duplicate";
    }
    if (other.documentId !== candidate.documentId || Math.abs(other.chunkIndex - candidate.chunkIndex) !== 1) {
      continue;
    }

    const [earlier, later] = other.chunkIndex < candidate.chunkIndex ? [other, candidate] : [candidate, other];
    const shorter = Math.min(earlier.content.length, later.content.length);
    if (boundaryOverlap(earlier.content, later.content, shorter) > shorter * MAX_OVERLAP_RATIO) {
      return "overlap";
    }
  }

  return null;
}

/**
 * Picks the chunks that become LLM context from candidates ordered by relevance. Deterministic:
 *
 * 1. drops exact duplicates and neighbouring chunks that mostly repeat an already chosen one;
 * 2. caps chunks per document, then backfills leftover slots from the capped ones;
 * 3. never exceeds the character budget (the best chunk is truncated if it alone is too big).
 */
export function selectContext(candidates: readonly RetrievedChunk[], budget: ContextBudget): ContextSelection {
  const selected: RetrievedChunk[] = [];
  const skipped: ContextSelection["skipped"] = [];
  const capped: RetrievedChunk[] = [];
  let usedChars = 0;
  const perDocument = new Map<string, number>();

  const tryAdd = (candidate: RetrievedChunk, enforceCap: boolean) => {
    if (selected.length >= budget.maxChunks) {
      return;
    }

    const redundant = redundancy(candidate, selected);
    if (redundant) {
      skipped.push({ chunkId: candidate.chunkId, reason: redundant });
      return;
    }
    if (enforceCap && (perDocument.get(candidate.documentId) ?? 0) >= budget.maxPerDocument) {
      capped.push(candidate);
      return;
    }

    let chunk = candidate;
    if (usedChars + chunk.content.length > budget.maxChars) {
      if (selected.length > 0) {
        skipped.push({ chunkId: candidate.chunkId, reason: "budget" });
        return;
      }
      chunk = { ...candidate, content: truncateText(candidate.content, budget.maxChars) };
    }

    selected.push(chunk);
    usedChars += chunk.content.length;
    perDocument.set(chunk.documentId, (perDocument.get(chunk.documentId) ?? 0) + 1);
  };

  for (const candidate of candidates) {
    tryAdd(candidate, true);
  }
  for (const candidate of capped) {
    tryAdd(candidate, false);
  }

  const rank = new Map(candidates.map((candidate, index) => [candidate.chunkId, index]));
  selected.sort((a, b) => (rank.get(a.chunkId) ?? 0) - (rank.get(b.chunkId) ?? 0));

  return { selected, skipped };
}
