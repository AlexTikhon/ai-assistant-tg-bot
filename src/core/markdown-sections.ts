/** An ATX heading ("## Title") found in a Markdown text. */
export type MarkdownHeading = {
  /** 1 for "#" ... 6 for "######". */
  level: number;
  /** The heading text with closing hashes removed and whitespace collapsed. */
  title: string;
  /** Offset in the parsed text of the first character of the heading line. */
  start: number;
};

/** Up to three spaces of indentation, 1-6 hashes, a space or tab, the title, optional closing hashes. */
const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const ATX_EMPTY = /^ {0,3}#{1,6}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The headings of a Markdown text, in order. A deliberately small parser - not a Markdown implementation:
 * only ATX headings ("#"-style; Setext "===" underlines are not recognised) outside fenced code blocks, so a
 * "# comment" in a shell snippet is not mistaken for a title. Pure and deterministic.
 */
export function parseMarkdownHeadings(text: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: string | null = null;
  let offset = 0;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const marker = FENCE.exec(line)?.[1];

    if (fence !== null) {
      // A closing fence uses the same character, is at least as long as the opening one and has nothing after it.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
        fence = null;
      }
    } else if (marker) {
      fence = marker;
    } else if (!ATX_EMPTY.test(line)) {
      const match = ATX_HEADING.exec(line);
      const title = match?.[2].replace(/\s+/g, " ").trim();
      if (match && title) {
        headings.push({ level: match[1].length, title, start: offset });
      }
    }

    offset += rawLine.length + 1;
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
