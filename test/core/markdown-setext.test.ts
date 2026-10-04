import { describe, expect, it } from "vitest";
import { parseMarkdownHeadings, sectionPathForRange } from "../../src/core/markdown-sections.js";

const titles = (text: string) => parseMarkdownHeadings(text).map((heading) => [heading.level, heading.title]);

describe("Setext headings", () => {
  it("a line underlined with === is a level 1 heading, located at its text line", () => {
    const text = "Introduction\n============\n\nbody";

    expect(parseMarkdownHeadings(text)).toEqual([{ level: 1, title: "Introduction", start: 0 }]);
  });

  it("a line underlined with --- is a level 2 heading", () => {
    const text = "intro\n\nSubheading\n----------\n\nbody";

    expect(parseMarkdownHeadings(text)).toEqual([{ level: 2, title: "Subheading", start: text.indexOf("Subheading") }]);
  });

  it("ignores Setext-looking text inside a fenced code block", () => {
    const text = ["# Real", "", "```", "Not a heading", "=============", "Neither", "-------", "```", "", "after"].join("\n");

    expect(titles(text)).toEqual([[1, "Real"]]);
  });

  it("works together with ATX headings and builds the same section hierarchy", () => {
    const text = "Guide\n=====\n\nintro\n\nSetup\n-----\n\ninstall it\n\n### Detail\n\nmore";
    const headings = parseMarkdownHeadings(text);

    expect(headings.map((heading) => [heading.level, heading.title])).toEqual([
      [1, "Guide"],
      [2, "Setup"],
      [3, "Detail"],
    ]);
    const install = text.indexOf("install it");
    expect(sectionPathForRange(headings, install, install + 10)).toEqual(["Guide", "Setup"]);
  });

  it("underline length and trailing spaces do not matter, a single character is enough", () => {
    expect(titles("Short\n=\n\nAlso\n--  \n")).toEqual([
      [1, "Short"],
      [2, "Also"],
    ]);
  });

  it("allows up to three spaces of indentation on the underline and the text, but not four", () => {
    expect(titles("  Indented\n   ====")).toEqual([[1, "Indented"]]);
    expect(titles("Text\n    ====")).toEqual([]); // four spaces: not an underline
  });

  it("a heading can span several lines of one paragraph", () => {
    const text = "A long title\nthat wraps\n========";

    expect(parseMarkdownHeadings(text)).toEqual([{ level: 1, title: "A long title that wraps", start: 0 }]);
  });

  it("an underline without a paragraph above it is not a heading: a rule after a blank line, or text only", () => {
    expect(titles("text\n\n---\n\nmore")).toEqual([]);
    expect(titles("\n=====\n")).toEqual([]);
    expect(titles("---\n")).toEqual([]);
  });

  it("does not turn list items, quotes, or a table-like line into headings", () => {
    expect(titles("- item\n---")).toEqual([]);
    expect(titles("> quoted\n---")).toEqual([]);
    expect(titles("1. numbered\n===")).toEqual([]);
    expect(titles("* star\n---")).toEqual([]);
  });

  it("an ATX heading line is never the text of a Setext heading", () => {
    expect(titles("# Real\n---")).toEqual([[1, "Real"]]);
  });

  it("YAML front matter does not become a heading", () => {
    const text = "---\ntitle: My document\nauthor: Someone\n---\n\n# Real\n\nbody";

    expect(titles(text)).toEqual([[1, "Real"]]);
  });

  it("a rule between sections is not a heading, but the paragraph above a --- directly is", () => {
    expect(titles("# A\n\ntext\n\n---\n\n# B")).toEqual([
      [1, "A"],
      [1, "B"],
    ]);
    expect(titles("# A\n\ntext\n---\n\n# B")).toEqual([
      [1, "A"],
      [2, "text"],
      [1, "B"],
    ]);
  });

  it("handles Windows line endings and keeps offsets exact", () => {
    const text = "Title\r\n=====\r\n\r\nSub\r\n---\r\n";

    expect(parseMarkdownHeadings(text)).toEqual([
      { level: 1, title: "Title", start: 0 },
      { level: 2, title: "Sub", start: text.indexOf("Sub") },
    ]);
  });

  it("a tilde fence and a longer backtick fence also hide Setext-looking lines", () => {
    expect(titles("~~~\nFoo\n===\n~~~\n\n````\nBar\n---\n````")).toEqual([]);
  });
});
