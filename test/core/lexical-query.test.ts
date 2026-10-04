import { describe, expect, it } from "vitest";
import { buildLexicalQuery } from "../../src/core/lexical-query.js";

describe("buildLexicalQuery", () => {
  it("quotes every term so FTS syntax in user text can never break the query", () => {
    expect(buildLexicalQuery('what is "ECONNRESET" AND NOT -foo* (bar)')).toBe('"ECONNRESET" OR "foo" OR "bar"');
  });

  it("keeps identifiers, file names and versions as one phrase", () => {
    expect(buildLexicalQuery("where is api_client.ts and gpt-4.1-mini used?")).toBe(
      '"api_client.ts" OR "gpt-4.1-mini" OR "used"',
    );
  });

  it("drops stop words, duplicates and punctuation-only input", () => {
    expect(buildLexicalQuery("The the THE what is it?")).toBeNull();
    expect(buildLexicalQuery("--- *** ???")).toBeNull();
    expect(buildLexicalQuery("error Error ERROR")).toBe('"error"');
  });

  it("supports non-latin text", () => {
    expect(buildLexicalQuery("ошибка подключения")).toBe('"ошибка" OR "подключения"');
  });

  it("limits the number of terms", () => {
    const query = buildLexicalQuery(Array.from({ length: 100 }, (_, i) => `term${i}`).join(" "));

    expect(query?.split(" OR ")).toHaveLength(24);
  });
});
