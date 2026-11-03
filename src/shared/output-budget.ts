import { safeCutIndex } from "./utils/text.js";

/** Defensive text bound, independent of provider tokenization and injected providers. UTF-16 units. */
export const MAX_GENERATED_TEXT_CHARS = 16_000;
export const OUTPUT_TRUNCATED_NOTICE = "\n\n[Response shortened to fit the output limit.]";

export function boundOutput(text: string, maxChars = MAX_GENERATED_TEXT_CHARS, shortened = false): string {
  if (text.length <= maxChars && (!shortened || text.endsWith(OUTPUT_TRUNCATED_NOTICE))) return text;
  const end = safeCutIndex(text, maxChars - OUTPUT_TRUNCATED_NOTICE.length);
  // Drop a numeric citation interrupted by the cut, keeping complete references intact.
  const prefix = text.slice(0, end).replace(/\[\d[\d\s,;]*$/, "").replace(/\[$/, "").trimEnd();
  return prefix + OUTPUT_TRUNCATED_NOTICE;
}
