import { describe, expect, it } from "vitest";
import { parseMarkdownHeadings, sectionPathForRange } from "../../src/core/markdown-sections.js";

const titles = (text: string) => parseMarkdownHeadings(text).map((heading) => [heading.level, heading.title]);

describe("parseMarkdownHeadings", () => {
  it("finds ATX headings with their level, title and the offset of their line", () => {
    const text = "# Authentication\nintro\n## Refresh tokens\nbody";

    expect(parseMarkdownHeadings(text)).toEqual([
      { level: 1, title: "Authentication", start: 0 },
      { level: 2, title: "Refresh tokens", start: text.indexOf("## Refresh") },
    ]);
  });

  it("ignores lines that only look like headings", () => {
    expect(titles("#hashtag\n####### seven\n#\n##   \nnot # a heading\n    # indented four spaces")).toEqual([]);
  });

  it("allows up to three spaces of indentation and strips closing hashes", () => {
    expect(titles("   ## Indented ##\n### Closed ###   ")).toEqual([
      [2, "Indented"],
      [3, "Closed"],
    ]);
  });

  it("does not treat comments inside fenced code blocks as headings", () => {
    const text = ["# Real", "```bash", "# a shell comment", "```", "## Also real", "~~~", "# tilde fence", "~~~", "### Last"].join("\n");

    expect(titles(text)).toEqual([
      [1, "Real"],
      [2, "Also real"],
      [3, "Last"],
    ]);
  });

  it("keeps a fence open until a matching closing fence, so a shorter fence inside does not end it", () => {
    const text = ["````md", "```", "# still code", "```", "````", "# After"].join("\n");

    expect(titles(text)).toEqual([[1, "After"]]);
  });

  it("collapses whitespace in titles and tolerates CRLF line endings", () => {
    expect(titles("#   Spaced    out\ttitle\r\n## Next\r\n")).toEqual([
      [1, "Spaced out title"],
      [2, "Next"],
    ]);
  });

  it("returns nothing for text without headings", () => {
    expect(parseMarkdownHeadings("just some text\n\nand more")).toEqual([]);
  });

  it("works on Unicode titles", () => {
    expect(titles("# Аутентификация\n## 認証トークン")).toEqual([
      [1, "Аутентификация"],
      [2, "認証トークン"],
    ]);
  });
});

describe("sectionPathForRange", () => {
  const text = [
    "Preamble before any heading.", // 0
    "# Authentication",
    "Intro to auth.",
    "## Refresh tokens",
    "Tokens refresh every hour.",
    "## Revocation",
    "Revoke with a call.",
    "# Billing",
    "Invoices monthly.",
    "## Refresh tokens",
    "A different section with the same name.",
  ].join("\n");
  const headings = parseMarkdownHeadings(text);
  const range = (needle: string, length = needle.length) => {
    const start = text.indexOf(needle);
    return [start, start + length] as const;
  };

  it("gives a top-level heading as a one-element path", () => {
    expect(sectionPathForRange(headings, ...range("Intro to auth."))).toEqual(["Authentication"]);
  });

  it("gives the whole heading hierarchy for a nested section", () => {
    expect(sectionPathForRange(headings, ...range("Tokens refresh every hour."))).toEqual(["Authentication", "Refresh tokens"]);
    expect(sectionPathForRange(headings, ...range("Revoke with a call."))).toEqual(["Authentication", "Revocation"]);
  });

  it("has an empty path for text before the first heading", () => {
    expect(sectionPathForRange(headings, ...range("Preamble before any heading."))).toEqual([]);
  });

  it("treats the heading line as part of the section it opens", () => {
    expect(sectionPathForRange(headings, ...range("## Revocation"))).toEqual(["Authentication", "Revocation"]);
  });

  it("returns to the parent after a nested section ends: a sibling does not inherit the previous sibling's path", () => {
    expect(sectionPathForRange(headings, ...range("Invoices monthly."))).toEqual(["Billing"]);
  });

  it("keeps same-named headings under different parents apart", () => {
    const first = sectionPathForRange(headings, ...range("Tokens refresh every hour."));
    const second = sectionPathForRange(headings, ...range("A different section with the same name."));

    expect(first).toEqual(["Authentication", "Refresh tokens"]);
    expect(second).toEqual(["Billing", "Refresh tokens"]);
  });

  it("names the section that holds most of a chunk that spans several, and the earlier one on a tie", () => {
    const [from] = range("Tokens refresh every hour.");
    const end = text.indexOf("Revoke with a call.") + "Revoke with a call.".length;

    // mostly the long Refresh tokens + Revocation text: the larger part is in "Refresh tokens" (27 chars) vs Revocation (up to 40)
    expect(sectionPathForRange(headings, from, end)).toEqual(["Authentication", "Revocation"]);
    // a range that starts in the tail of one section and has a little more in the next belongs to the one with more text
    const spill = text.indexOf("## Revocation") + 4;
    expect(sectionPathForRange(headings, spill - 20, spill)).toEqual(["Authentication", "Refresh tokens"]);
  });

  it("copes with skipped levels (a ### directly below a #)", () => {
    const skipped = "# A\n### Deep\ntext\n## Shallower\nmore";
    const parsed = parseMarkdownHeadings(skipped);

    expect(sectionPathForRange(parsed, skipped.indexOf("text"), skipped.indexOf("text") + 4)).toEqual(["A", "Deep"]);
    expect(sectionPathForRange(parsed, skipped.indexOf("more"), skipped.indexOf("more") + 4)).toEqual(["A", "Shallower"]);
  });

  it("is empty when there are no headings or the range is empty", () => {
    expect(sectionPathForRange([], 0, 10)).toEqual([]);
    expect(sectionPathForRange(headings, 40, 40)).toEqual([]);
  });
});
