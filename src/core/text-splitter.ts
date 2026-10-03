import { safeCutIndex } from "../shared/utils/text.js";
import type { ChunkDraft } from "./document.js";

export type SplitOptions = {
  /** Maximum chunk length in characters (including overlap). */
  chunkSize: number;
  /** Approximate number of trailing characters repeated at the start of the next chunk. */
  chunkOverlap: number;
};

/** Boundaries tried from the coarsest (paragraph) to the finest (word). */
const SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " "];

/** Splits text after every occurrence of `separator`, keeping the separator on the left piece. */
function splitAfter(text: string, separator: string) {
  const parts: string[] = [];
  let position = 0;

  while (position < text.length) {
    const index = text.indexOf(separator, position);
    if (index === -1) {
      parts.push(text.slice(position));
      break;
    }
    const end = index + separator.length;
    parts.push(text.slice(position, end));
    position = end;
  }

  return parts;
}

/** Breaks text into pieces no longer than `size`, preferring the coarsest separator that works. */
function toAtoms(text: string, size: number, separators: readonly string[]): string[] {
  if (text.length <= size) {
    return [text];
  }

  const [separator, ...rest] = separators;
  if (separator === undefined) {
    return hardSplit(text, size);
  }

  const parts = splitAfter(text, separator);
  if (parts.length === 1) {
    return toAtoms(text, size, rest);
  }

  return parts.flatMap((part) => (part.length <= size ? [part] : toAtoms(part, size, rest)));
}

/** Last resort for text without any usable boundary (e.g. one huge token). */
function hardSplit(text: string, size: number) {
  const pieces: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = safeCutIndex(text, Math.min(start + size, text.length));
    if (end <= start) {
      end = Math.min(start + size, text.length);
    }
    pieces.push(text.slice(start, end));
    start = end;
  }

  return pieces;
}

/** Trailing part of a chunk (<= `limit` chars) that starts at a word boundary, or "" if none. */
function overlapTail(chunk: string, limit: number) {
  if (limit <= 0 || chunk.length <= limit) {
    return "";
  }

  for (let index = chunk.length - limit; index < chunk.length; index += 1) {
    if (/\s/.test(chunk[index - 1] ?? "")) {
      return chunk.slice(index);
    }
  }

  return "";
}

/**
 * Splits text into overlapping chunks that respect paragraph, line, sentence and word boundaries
 * (in that order of preference). Words are only cut when a single token exceeds `chunkSize`.
 */
export function splitText(text: string, options: SplitOptions): ChunkDraft[] {
  const { chunkSize, chunkOverlap } = options;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("chunkSize must be a positive integer");
  }
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new RangeError("chunkOverlap must be an integer in [0, chunkSize)");
  }

  const atoms = toAtoms(text, chunkSize, SEPARATORS);
  const chunks: string[] = [];
  let current = "";

  for (const atom of atoms) {
    if (current.length + atom.length <= chunkSize) {
      current += atom;
      continue;
    }

    chunks.push(current);
    const overlap = overlapTail(current, chunkOverlap);
    current = overlap.length + atom.length <= chunkSize ? overlap + atom : atom;
  }
  chunks.push(current);

  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((content, chunkIndex) => ({ chunkIndex, content }));
}
