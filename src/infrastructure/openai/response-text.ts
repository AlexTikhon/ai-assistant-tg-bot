import { boundOutput, MAX_GENERATED_TEXT_CHARS } from "../../shared/output-budget.js";

/** Normalizes LangChain message content (string or array of content parts) into bounded trimmed text. */
export function readTextContent(content: unknown) {
  if (typeof content === "string") {
    return boundOutput(content.trim());
  }

  if (Array.isArray(content)) {
    let text = "";
    for (const part of content) {
      const value = typeof part === "string" ? part : typeof part === "object" && part !== null && typeof part.text === "string" ? part.text : "";
      // Only retain enough to detect overflow, rather than joining an unbounded parts array.
      text += value.slice(0, MAX_GENERATED_TEXT_CHARS + 1 - text.length);
      if (text.length > MAX_GENERATED_TEXT_CHARS) break;
    }
    return boundOutput(text).trim();
  }

  return "";
}
