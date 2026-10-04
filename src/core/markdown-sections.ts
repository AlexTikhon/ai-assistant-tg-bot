/** An ATX ("## Title") or Setext ("Title" underlined with === or ---) heading found in a Markdown text. */
export type MarkdownHeading = {
  /** 1 for "#" or "===" ... 6 for "######"; a "---" underline is level 2. */
  level: number;
  /** The heading text with closing hashes removed and whitespace collapsed. */
  title: string;
  /** Offset in the parsed text of the first character of the heading's first line. */
  start: number;
};

/** Up to three spaces of indentation, 1-6 hashes, a space or tab, the title, optional closing hashes. */
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const ATX_EMPTY = /^ {0,3}#{1,6}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** Up to three spaces, then only "=" or only "-" (any length), nothing else. */
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
/** "***", "---", "___" (three or more, spaces allowed between): a rule, which never carries heading text. */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** A block quote or list item: these interrupt a paragraph and are never Setext heading text. */
const QUOTE_OR_LIST = /^ {0,3}(?:>|[-+*][ \t]|\d{1,9}[.)][ \t])/;
const INDENTED = /^(?: {4}|\t)/;

type Paragraph = { start: number; lines: string[] };

/** Lines of a leading YAML front matter block ("---" ... "---"/"..."), or 0 when the text has none. */
function frontMatterLength(lines: string[]): number {
  if (lines[0]?.trimEnd() !== "---") {
    return 0;
  }
  const end = lines.findIndex((line, index) => index > 0 && (line.trimEnd() === "---" || line.trimEnd() === "..."));
  return end === -1 ? 0 : end + 1;
}

/**
 * The headings of a Markdown text, in order. A deliberately small parser - not a Markdown implementation:
 * ATX headings ("#"), and Setext headings (a paragraph underlined with "===" for level 1 or "---" for level
 * 2), always outside fenced code blocks, so a "# comment" or a "=====" in a code sample is not mistaken for a
 * title. A heading is only recognised where CommonMark would: Setext text is the paragraph directly above the
 * underline (a rule after a blank line, a list item or a quote is not one), and YAML front matter is skipped
 * rather than read as a heading. Pure and deterministic.
 */
export function parseMarkdownHeadings(text: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const rawLines = text.split("\n");
  const lines = rawLines.map((rawLine) => (rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine));

  let fence: string | null = null;
  let paragraph: Paragraph | null = null;
  let offset = 0;
  const skipped = frontMatterLength(lines);

  for (const [index, line] of lines.entries()) {
    const lineStart = offset;
    offset += rawLines[index].length + 1;

    if (index < skipped) {
      continue;
    }

    const marker = FENCE.exec(line)?.[1];

    if (fence !== null) {
      // A closing fence uses the same character, is at least as long as the opening one and has nothing after it.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      paragraph = null;
      continue;
    }

    if (line.trim() === "") {
      paragraph = null;
      continue;
    }

    const underline = paragraph ? SETEXT_UNDERLINE.exec(line) : null;
    if (paragraph && underline) {
      const title = paragraph.lines.join(" ").replace(/\s+/g, " ").trim();
      if (title) {
        headings.push({ level: underline[1][0] === "=" ? 1 : 2, title, start: paragraph.start });
      }
      paragraph = null;
      continue;
    }

    if (!ATX_EMPTY.test(line)) {
      const match = ATX_HEADING.exec(line);
      const title = match?.[2].replace(/\s+/g, " ").trim();
      if (match && title) {
        headings.push({ level: match[1].length, title, start: lineStart });
        paragraph = null;
        continue;
      }
    }

    if (THEMATIC_BREAK.test(line) || QUOTE_OR_LIST.test(line) || ATX_EMPTY.test(line)) {
      paragraph = null;
    } else if (paragraph) {
      paragraph.lines.push(line.trim()); // a continuation line (indented ones too, as in CommonMark)
    } else if (!INDENTED.test(line)) {
      paragraph = { start: lineStart, lines: [line.trim()] };
    }
  }

  return headings;
}

/**
 * The heading hierarchy of the section that holds most of the characters in [start, end), from the top level
 * down ("Authentication" > "Refresh tokens"); an earlier section wins a tie. A heading line belongs to the
 * section it opens. Text before the first heading has an empty path, which is a fact, not a gap: the caller
 * shows the chunk number then.
 *
 * Chunks may span several sections and overlap their neighbours, so a single path is a label for where the
 * bulk of the chunk is - never a claim that the whole chunk lies below that heading.
 */
export function sectionPathForRange(headings: readonly MarkdownHeading[], start: number, end: number): string[] {
  if (end <= start || headings.length === 0) {
    return [];
  }

  // Build every section's path once: sections are the stretches between consecutive headings.
  const stack: MarkdownHeading[] = [];
  let best: { path: string[]; characters: number } | undefined;
  const consider = (path: string[], from: number, to: number) => {
    const characters = Math.min(end, to) - Math.max(start, from);
    if (characters > 0 && (best === undefined || characters > best.characters)) {
      best = { path, characters };
    }
  };

  consider([], 0, headings[0].start);
  headings.forEach((heading, index) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) {
      stack.pop();
    }
    stack.push(heading);
    consider(
      stack.map((item) => item.title),
      heading.start,
      headings[index + 1]?.start ?? Number.POSITIVE_INFINITY,
    );
  });

  return best?.path ?? [];
}
