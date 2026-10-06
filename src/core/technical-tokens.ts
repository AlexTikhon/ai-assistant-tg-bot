import { ENGLISH_STOP_WORDS, extractTerms } from "./lexical-query.js";

type TechnicalTokenKind = "identifier" | "filename" | "version";

export type TechnicalToken = { text: string; kind: TechnicalTokenKind };

/** What a question explicitly names, found without any model. Features only: nothing here decides anything. */
export type QueryFeatures = {
  /** Identifiers, file names and versions, distinct, in order of appearance. */
  technicalTokens: TechnicalToken[];
  /** Phrases the user put in double quotes (two words or more). */
  quotedPhrases: string[];
  /** Everything a relevant chunk is expected to contain verbatim: the tokens, then the quoted phrases. */
  exactTargets: string[];
};

/** Extensions that make `name.ext` a file name rather than two words glued by a full stop. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "md txt pdf doc docx csv tsv json jsonl yaml yml toml xml html htm css scss js mjs cjs ts tsx jsx py rb go rs java kt " +
    "sh bash ps1 sql log conf cfg ini env lock service timer socket properties gradle xlsx pptx png jpg jpeg gif svg zip tar gz"
  ).split(" "),
);

const VERSION = /^[vV]\d+(?:\.\d+)+(?:[-+][\p{L}\p{N}.]+)?$|^\d+(?:\.\d+){2,}(?:[-+][\p{L}\p{N}.]+)?$/u;
/** "3rd", "24h", "5pm": a number with a unit or ordinal suffix is ordinary language. */
const NUMBER_WITH_SUFFIX = /^\d+\p{L}{1,3}$/u;
const DOTTED_NAME = /^\p{Ll}[\p{Ll}\p{N}_]+(?:\.\p{Ll}[\p{Ll}\p{N}_]+)+$/u;
/** Shortest all-capitals word that counts (5 letters): shorter acronyms (API, HTTP, JSON) are generic and match everything. */
const ALL_CAPS = /^\p{Lu}{5,}$/u;
/** lowerCamelCase (useEffect, getUserId). PascalCase is left out: product names (PostgreSQL, PurrFeed) are ordinary prose. */
const CAMEL_CASE = /^\p{Ll}+\p{Lu}/u;

function classify(term: string, shouting: boolean): TechnicalTokenKind | null {
  if (VERSION.test(term)) {
    return "version";
  }

  const extension = term.includes(".") ? term.slice(term.lastIndexOf(".") + 1).toLowerCase() : "";
  if (FILE_EXTENSIONS.has(extension) && term.length > extension.length + 2) {
    return "filename";
  }

  const hasLetter = /\p{L}/u.test(term);
  const hasDigit = /\p{N}/u.test(term);
  const slashes = term.split("/").length - 1;

  const identifier =
    term.includes("_") ||
    slashes >= 2 ||
    (slashes === 1 && term.includes(".")) ||
    DOTTED_NAME.test(term) ||
    (hasLetter && hasDigit && !NUMBER_WITH_SUFFIX.test(term)) ||
    CAMEL_CASE.test(term) ||
    (!shouting && ALL_CAPS.test(term) && !ENGLISH_STOP_WORDS.has(term.toLowerCase()));

  return identifier ? "identifier" : null;
}

const QUOTED = /"([^"\n]+)"|“([^”\n]+)”|«([^»\n]+)»/gu;

/**
 * Identifiers, file names and versions mentioned in a text: ECONNRESET, E-4012, HTTP_429, useEffect,
 * user_id, v2.14.1, ABC-123, config/settings.yaml. Deliberately conservative - a word is only technical if
 * its *shape* says so (an underscore, a digit next to letters, camelCase, a long ACRONYM, a path, a known
 * file extension, a version number). Ordinary words, hyphenated words, plain numbers and short acronyms are
 * not. Works on Unicode letters; text without letter case (CJK) has no identifiers other than by digits
 * and separators. Pure and deterministic.
 */
export function extractTechnicalTokens(text: string): TechnicalToken[] {
  const terms = extractTerms(text);
  // A question typed in capitals has no information in its capitals (a bare "ECONNRESET" still counts).
  const letters = terms.filter((term) => /\p{L}/u.test(term));
  const shouting = letters.length >= 3 && letters.every((term) => term === term.toUpperCase());

  const tokens = new Map<string, TechnicalToken>();
  for (const term of terms) {
    const key = term.toLowerCase();
    const kind = classify(term, shouting);
    if (kind && !tokens.has(key)) {
      tokens.set(key, { text: term, kind });
    }
  }
  return [...tokens.values()];
}

/** Double-quoted phrases of at least two words, distinct, in order of appearance. */
function extractQuotedPhrases(text: string): string[] {
  const phrases = new Map<string, string>();
  for (const match of text.normalize("NFC").matchAll(QUOTED)) {
    const phrase = (match[1] ?? match[2] ?? match[3]).replace(/\s+/g, " ").trim();
    if (extractTerms(phrase).length >= 2 && !phrases.has(phrase.toLowerCase())) {
      phrases.set(phrase.toLowerCase(), phrase);
    }
  }
  return [...phrases.values()];
}

export function analyzeQuery(text: string): QueryFeatures {
  const technicalTokens = extractTechnicalTokens(text);
  const quotedPhrases = extractQuotedPhrases(text);
  return { technicalTokens, quotedPhrases, exactTargets: [...technicalTokens.map((token) => token.text), ...quotedPhrases] };
}

const squash = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").toLowerCase();
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Whether `content` contains `target` as a whole token or phrase: case and whitespace insensitive, and
 * never as a part of a longer token (E-4012 is not in E-40120 or XE-4012, v2.14.1 is not in v2.14.10).
 */
export function containsExactTarget(content: string, target: string): boolean {
  const haystack = squash(content);
  const needle = squash(target).trim();
  if (needle === "") {
    return false;
  }

  for (let from = haystack.indexOf(needle); from !== -1; from = haystack.indexOf(needle, from + 1)) {
    const before = haystack[from - 1];
    const after = haystack[from + needle.length];
    if ((before === undefined || !WORD_CHARACTER.test(before)) && (after === undefined || !WORD_CHARACTER.test(after))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a chunk is evidence for an exact target: the target occurs in its text, or it names the chunk's
 * document (asking about `cat-feeder.md` is satisfied by a chunk of that file; folders are ignored).
 */
export function matchesExactTarget(chunk: { fileName: string; content: string }, target: string): boolean {
  const baseName = chunk.fileName.split(/[/\\]/).pop() ?? chunk.fileName;
  return baseName.toLowerCase() === target.trim().toLowerCase() || containsExactTarget(chunk.content, target);
}
