/** Normalizes LangChain message content (string or array of content parts) into plain trimmed text. */
export function readTextContent(content: unknown) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part === "object" && part !== null && "text" in part) return String(part.text);
        return "";
      })
      .join("")
      .trim();
  }

  return "";
}
