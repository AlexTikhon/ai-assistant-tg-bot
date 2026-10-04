import type { ChunkText } from "./document.js";

/** Overlaps shorter than this are coincidence (a shared word or two), not splitter overlap. */
const DEFAULT_MIN_OVERLAP = 16;

/**
 * Length of the longest suffix of `previous` that is also a prefix of `next` (0 if shorter than
 * `minChars`). The text splitter repeats the tail of a chunk at the start of the next one, so for
 * neighbouring chunks this is exactly the repeated part. Only looks at `maxChars` characters.
 */
export function boundaryOverlap(previous: string, next: string, maxChars: number, minChars = DEFAULT_MIN_OVERLAP) {
  const limit = Math.min(maxChars, previous.length, next.length);

  for (let length = limit; length >= Math.max(1, minChars); length -= 1) {
    if (previous.endsWith(next.slice(0, length))) {
      return length;
    }
  }

  return 0;
}

/**
 * Chunk texts of one document with the splitter's overlap removed from every chunk that directly
 * follows its predecessor (consecutive `chunkIndex`), so concatenating them does not repeat text.
 * Only boundary overlap is touched - repeated passages elsewhere in the document are kept.
 *
 * `overlapChars` is the CHUNK_OVERLAP the document was split with (0 disables trimming). Chunks of a
 * document split with a larger overlap than configured are only partially trimmed.
 */
export function trimChunkOverlap(
  chunks: readonly ChunkText[],
  overlapChars: number,
  minOverlap = DEFAULT_MIN_OVERLAP,
): string[] {
  return chunks.map((chunk, position) => {
    const previous = chunks[position - 1];
    if (!previous || previous.chunkIndex + 1 !== chunk.chunkIndex || overlapChars <= 0) {
      return chunk.content;
    }

    const repeated = boundaryOverlap(previous.content, chunk.content, overlapChars, minOverlap);
    return chunk.content.slice(repeated).trimStart();
  });
}
