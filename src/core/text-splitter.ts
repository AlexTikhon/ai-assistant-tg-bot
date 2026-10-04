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

/** A chunk plus the character range [start, end) of the splitter input it was cut from. */
export type PositionedChunk = ChunkDraft & { start: number; end: number };

/**
 * Splits text into overlapping chunks that respect paragraph, line, sentence and word boundaries
 * (in that order of preference). Words are only cut when a single token exceeds `chunkSize`.
 *
 * Every chunk is a contiguous slice of the input (`text.slice(start, end) === content`): atoms tile the
 * text exactly and the overlap is the tail of the preceding atoms. That is what makes it possible to map
 * a chunk back to the page(s) it came from.
 */
export function splitTextWithOffsets(text: string, options: SplitOptions): PositionedChunk[] {
  const { chunkSize, chunkOverlap } = options;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError("chunkSize must be a positive integer");
  }
  if (!Number.isInteger(chunkOverlap) || chunkOverlap < 0 || chunkOverlap >= chunkSize) {
    throw new RangeError("chunkOverlap must be an integer in [0, chunkSize)");
  }

  const raw: Array<{ text: string; start: number }> = [];
  let current = "";
  let currentStart = 0;
  let atomStart = 0;

  for (const atom of toAtoms(text, chunkSize, SEPARATORS)) {
    if (current.length + atom.length <= chunkSize) {
      if (current === "") {
        currentStart = atomStart;
      }
      current += atom;
    } else {
      raw.push({ text: current, start: currentStart });
      const overlap = overlapTail(current, chunkOverlap);
      const keepOverlap = overlap.length + atom.length <= chunkSize;
      current = keepOverlap ? overlap + atom : atom;
      currentStart = keepOverlap ? atomStart - overlap.length : atomStart;
    }
    atomStart += atom.length;
  }
  raw.push({ text: current, start: currentStart });

  return raw
    .flatMap(({ text: chunk, start }) => {
      const content = chunk.trim();
      if (content.length === 0) {
        return [];
      }
      const trimmedStart = start + (chunk.length - chunk.trimStart().length);
      return [{ content, start: trimmedStart, end: trimmedStart + content.length }];
    })
    .map((chunk, chunkIndex) => ({ chunkIndex, ...chunk }));
}

/** Like `splitTextWithOffsets`, without the positions. */
export function splitText(text: string, options: SplitOptions): ChunkDraft[] {
  return splitTextWithOffsets(text, options).map(({ chunkIndex, content }) => ({ chunkIndex, content }));
}
