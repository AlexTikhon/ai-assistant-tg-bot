/**
 * Normalizes extracted text while keeping paragraph structure.
 *
 * Removes NUL bytes and BOMs, unifies line endings, collapses runs of spaces/tabs and limits
 * blank lines to one, so the splitter can still prefer paragraph and line boundaries.
 */
export function normalizeText(input: string) {
  return input
    .replace(/[\u0000﻿]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Truncates text to a fixed length while reserving space for an ellipsis. */
export function truncateText(input: string, maxLength: number) {
  if (input.length <= maxLength) {
    return input;
  }

  return `${input.slice(0, maxLength - 3).trim()}...`;
}

/** Returns a cut position <= `index` that does not fall between the halves of a surrogate pair. */
export function safeCutIndex(text: string, index: number) {
  if (index <= 0 || index >= text.length) {
    return Math.max(0, Math.min(index, text.length));
  }

  const previous = text.charCodeAt(index - 1);
  const isHighSurrogate = previous >= 0xd800 && previous <= 0xdbff;
  return isHighSurrogate ? index - 1 : index;
}
