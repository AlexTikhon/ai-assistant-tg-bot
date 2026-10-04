const MAX_TERMS = 24;

/** Words that match nearly every chunk and say nothing about relevance. Deliberately short. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  (
    "a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my not of on or so than that the their them then there these they this to was we were what when where " +
    "which who why will with would you your"
  ).split(" "),
);

/** A word, or an identifier-like run (api_client.ts, gpt-4.1-mini, src/app) that is searched as a phrase. */
const TERM = /[\p{L}\p{N}](?:[\p{L}\p{N}_./-]*[\p{L}\p{N}])?/gu;

/**
 * Turns free text into a safe SQLite FTS5 MATCH expression: every term is double-quoted (so user
 * input can never be parsed as FTS operators) and terms are OR-ed, letting BM25 rank by how many
 * rare terms a chunk contains. Returns null when nothing searchable is left.
 */
export function buildLexicalQuery(text: string): string | null {
  const terms = new Map<string, string>();

  for (const [term] of text.matchAll(TERM)) {
    const key = term.toLowerCase();
    if (!STOP_WORDS.has(key) && !terms.has(key)) {
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
