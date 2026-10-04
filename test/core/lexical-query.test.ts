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

describe("buildLexicalQuery: technical identifiers survive normalization", () => {
  it.each([
    ["ECONNRESET", '"ECONNRESET"'],
    ["foo.bar", '"foo.bar"'],
    ["HTTP_429", '"HTTP_429"'],
    ["user_id", '"user_id"'],
    ["src/app/main.ts", '"src/app/main.ts"'],
    ["gpt-4.1-mini", '"gpt-4.1-mini"'],
    ["v1.2.3", '"v1.2.3"'],
    ["3.11.4", '"3.11.4"'],
  ])("keeps %s intact", (identifier, expected) => {
    expect(buildLexicalQuery(identifier)).toBe(expected);
    expect(buildLexicalQuery(`why does ${identifier} happen?`)).toContain(expected);
  });

  it("strips trailing sentence punctuation but not the identifier's own punctuation", () => {
    expect(buildLexicalQuery("Is it ECONNRESET?")).toBe('"ECONNRESET"');
    expect(buildLexicalQuery("see foo.bar, then user_id.")).toBe('"see" OR "foo.bar" OR "user_id"');
    expect(buildLexicalQuery("(HTTP_429)")).toBe('"HTTP_429"');
  });

  it("keeps camelCase identifiers whole and does not split them into words", () => {
    expect(buildLexicalQuery("useEffect")).toBe('"useEffect"');
    expect(buildLexicalQuery("getUserById fails")).toBe('"getUserById" OR "fails"');
  });

  it("does not split identifiers that are not camelCase", () => {
    expect(buildLexicalQuery("ECONNRESET HTTP2 OAuth2 snake_case")).not.toContain("E CONN");
    expect(buildLexicalQuery("snake_case")).toBe('"snake_case"');
  });

  it("treats hyphenated prose terms as one phrase", () => {
    expect(buildLexicalQuery("a well-known fail-over")).toBe('"well-known" OR "fail-over"');
  });
});

describe("buildLexicalQuery: prose and Unicode", () => {
  it("drops contraction fragments instead of searching for 's' and 't'", () => {
    expect(buildLexicalQuery("what's the cat's name? don't panic")).toBe('"cat" OR "name" OR "don" OR "panic"');
    expect(buildLexicalQuery("the dog’s bowl")).toBe('"dog" OR "bowl"');
  });

  it("keeps accented and non-latin words and treats composed/decomposed forms alike", () => {
    const composed = buildLexicalQuery("café résumé");
    const decomposed = buildLexicalQuery("café résumé");

    expect(composed).toBe('"café" OR "résumé"');
    expect(decomposed).toBe(composed);
    expect(buildLexicalQuery("Straße 日本語 привет")).toBe('"Straße" OR "日本語" OR "привет"');
  });

  it("accepts a replacement stop-word list for other languages", () => {
    const german = new Set(["der", "die", "das", "ist"]);

    expect(buildLexicalQuery("Der Server ist down", { stopWords: german })).toBe('"Server" OR "down"');
    expect(buildLexicalQuery("the server", { stopWords: german })).toBe('"the" OR "server"');
  });

  it("never lets quotes or FTS operators through, whatever the input", () => {
    const query = buildLexicalQuery('NEAR("a" "b") OR "x"* ^col:foo {bar}');

    // Every term is a plain quoted phrase, so even the word NEAR is data and not an operator.
    expect(query).toMatch(/^"[^"*^:{}]+"( OR "[^"*^:{}]+")*$/);
    expect(query).toBe('"NEAR" OR "b" OR "x" OR "col" OR "foo" OR "bar"');
  });
});
