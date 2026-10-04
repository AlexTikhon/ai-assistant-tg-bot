const MAX_TERMS = 24;

/**
 * English words that match nearly every chunk and say nothing about relevance. Deliberately short.
 * The single letters are what is left of contractions ("what's" -> "what", "s") once apostrophes are
 * treated as separators. Pass another set to `buildLexicalQuery` for other languages.
 */
export const ENGLISH_STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my not of on or so than that the their them then there these they this to was we were what when where " +
    "which who why will with would you your s t d ll re ve m"
  ).split(" "),
);

/**
 * A word, or an identifier-like run (api_client.ts, gpt-4.1-mini, src/app, v1.2.3) that is searched as a phrase.
 * Combining marks (\p{M}) belong to the word so decomposed accents are not torn off their letters.
 */
const TERM = /[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}_./-]*[\p{L}\p{N}\p{M}])?/gu;

/** Possessive 's: "cat's" is about the cat, and the SQLite tokenizer would otherwise leave a stray "s". */
const POSSESSIVE = /['’]s\b/gi;

export type LexicalQueryOptions = {
  /** Lower-case words that are ignored. Defaults to a short English list. */
  stopWords?: ReadonlySet<string>;
};

/**
 * Turns free text into a safe SQLite FTS5 MATCH expression: every term is double-quoted (so user
 * input can never be parsed as FTS operators) and terms are OR-ed, letting BM25 rank by how many
 * rare terms a chunk contains. Returns null when nothing searchable is left.
 *
 * Identifiers are never rewritten or split. The FTS tokenizer (unicode61) lower-cases and splits at
 * punctuation, so `HTTP_429`, `foo.bar` and `v1.2.3` are matched as the token sequences they were indexed as.
 * (Also searching the spelled-out form of camelCase names was tried and removed: a two-word phrase
 * out-scores the single verbatim token in BM25, so paraphrases outranked the exact identifier.)
 */
export function buildLexicalQuery(text: string, options: LexicalQueryOptions = {}): string | null {
  const stopWords = options.stopWords ?? ENGLISH_STOP_WORDS;
  const terms = new Map<string, string>();

  for (const [term] of text.normalize("NFC").replace(POSSESSIVE, "").matchAll(TERM)) {
    const key = term.toLowerCase();
    if (!stopWords.has(key) && !terms.has(key)) {
      terms.set(key, term);
    }
  }

  if (terms.size === 0) {
    return null;
  }

  return [...terms.values()]
    .slice(0, MAX_TERMS)
    .map((term) => `"${term}"`)
    .join(" OR ");
}
