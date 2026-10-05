/**
 * Lightweight checks that an upload really is what its extension claims. No magic-number library: PDF has a mandatory
 * signature, and text is recognised by what it is not (binary data, bytes that are not UTF-8).
 */

/** A PDF starts with "%PDF-"; readers accept it anywhere in the first 1024 bytes (some producers prepend a few bytes). */
const PDF_SIGNATURE = "%PDF-";
const PDF_SIGNATURE_WINDOW = 1024;

export function hasPdfSignature(data: Buffer) {
  return data.subarray(0, PDF_SIGNATURE_WINDOW).includes(PDF_SIGNATURE);
}

/**
 * Of the characters of a text file, at most this share may be U+FFFD (what invalid UTF-8 decodes to). A few damaged bytes in a
 * large text are tolerated; a file in another encoding (Windows-1251, Latin-1) decodes mostly to replacement characters.
 */
const MAX_REPLACEMENT_SHARE = 0.01;

export type TextProblem = "pdf" | "binary" | "not-utf8";

/** Why the bytes cannot be treated as UTF-8 text, or null when they can. */
export function findTextProblem(data: Buffer): TextProblem | null {
  if (data.subarray(0, PDF_SIGNATURE.length).toString("latin1") === PDF_SIGNATURE) {
    return "pdf"; // a PDF named .txt: indexing its raw bytes would only produce garbage
  }
  // A NUL byte does not occur in text files; it is everywhere in images, archives, executables, office documents and UTF-16 text.
  if (data.includes(0)) {
    return "binary";
  }

  const text = new TextDecoder("utf-8").decode(data);
  let replacements = 0;
  for (let index = text.indexOf("�"); index !== -1; index = text.indexOf("�", index + 1)) {
    replacements += 1;
  }
  return replacements > text.length * MAX_REPLACEMENT_SHARE ? "not-utf8" : null;
}

/** The longest display name kept as metadata (characters). Telegram's own limit is shorter in practice; this only bounds what is stored. */
export const MAX_DISPLAY_NAME_LENGTH = 255;

/**
 * A user's file name as it is stored and shown: metadata, never a path. Unicode names are kept as they are; what could mislead
 * or break a display is removed (control characters, bidirectional overrides that make "txt.exe" read as "exe.txt", zero-width
 * characters), whitespace is collapsed, and the length is bounded - the extension is always kept.
 */
export function normalizeDisplayFileName(fileName: string) {
  const cleaned = fileName
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length <= MAX_DISPLAY_NAME_LENGTH) {
    return cleaned;
  }

  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
  let base = cleaned.slice(0, MAX_DISPLAY_NAME_LENGTH - extension.length);
  // Never end in the first half of a surrogate pair.
  const last = base.charCodeAt(base.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) base = base.slice(0, -1);
  return `${base.trimEnd()}${extension}`;
}
