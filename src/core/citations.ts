import { formatSectionPath } from "./provenance.js";
import type { SourceProvenance } from "./provenance.js";

export type CitationCheck = {
  /** The answer with references to non-existent sources removed. */
  text: string;
  /** Distinct, valid source numbers the answer cites, ascending. */
  cited: number[];
  /** Distinct source numbers that were cited but do not exist (and were removed), ascending. */
  unknown: number[];
};

/**
 * A run of adjacent citation brackets - [1], [1, 2], [1][2] - that does not follow a word character, so
 * code such as arr[5] or matrix[1][2] is left alone. Up to three digits: [2024] is a year, not a source.
 */
const CITATION_RUN = /(?<![\p{L}\p{N}_\]])(?:\[\d{1,3}(?:\s*[,;]\s*\d{1,3})*\])+/gu;
const BRACKET = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;

/**
 * Deterministic sanity check of the [n] references in a generated answer: every reference must point to
 * one of the `sourceCount` sources the model was shown. References to anything else are removed so the
 * user is never sent to a source that does not exist.
 *
 * This only verifies that the numbers are valid. It says nothing about whether the cited source really
 * supports the sentence - that would need a judge, and is deliberately not attempted here.
 */
export function groundCitations(answer: string, sourceCount: number): CitationCheck {
  const cited = new Set<number>();
  const unknown = new Set<number>();
  let text = "";
  let position = 0;

  for (const run of answer.matchAll(CITATION_RUN)) {
    const kept: string[] = [];
    let changed = false;

    for (const [bracket, list] of run[0].matchAll(BRACKET)) {
      const numbers = list.split(/[,;]/).map((part) => Number(part));
      const valid = numbers.filter((number) => number >= 1 && number <= sourceCount);
      numbers.forEach((number) => (valid.includes(number) ? cited : unknown).add(number));

      changed ||= valid.length !== numbers.length;
      if (valid.length > 0) {
        kept.push(valid.length === numbers.length ? bracket : `[${valid.join(", ")}]`);
      }
    }

    text += answer.slice(position, run.index);
    position = run.index + run[0].length;

    if (!changed) {
      text += run[0];
    } else if (kept.length > 0) {
      text += kept.join("");
    } else {
      // Drop the space that introduced the reference as well ("limit [99]." -> "limit.").
      text = text.replace(/ $/, "");
    }
  }
  text += answer.slice(position);

  return {
    text,
    cited: [...cited].sort((a, b) => a - b),
    unknown: [...unknown].sort((a, b) => a - b),
  };
}

const pages = (start: string | number, end: string | number) => (start === end ? `p. ${start}` : `pp. ${start}–${end}`);

/**
 * Where in the source a chunk sits, for humans - the richest provenance that is known:
 *
 * - PDF: the physical pages ("p. 8", "pp. 12–13"). When the file also declares printed page labels that differ
 *   from the physical numbers, both are shown so they cannot be mistaken for each other:
 *   "pp. iii–iv (PDF pp. 5–6)". A range is only shown when both ends are known.
 * - Markdown: the section ("Authentication > Refresh tokens").
 * - otherwise the 1-based chunk position ("chunk 4").
 */
export function formatSourceLocation(location: { chunkIndex: number } & SourceProvenance) {
  const { pageStart, pageEnd, pageLabelStart, pageLabelEnd, sectionPath } = location;

  if (pageStart !== undefined && pageEnd !== undefined) {
    const labelled = pageLabelStart !== undefined && pageLabelEnd !== undefined;
    if (labelled && (pageLabelStart !== String(pageStart) || pageLabelEnd !== String(pageEnd))) {
      return `${pages(pageLabelStart, pageLabelEnd)} (PDF ${pages(pageStart, pageEnd)})`;
    }
    return pages(pageStart, pageEnd);
  }
  if (sectionPath && sectionPath.length > 0) {
    return formatSectionPath(sectionPath);
  }
  return `chunk ${location.chunkIndex + 1}`;
}
