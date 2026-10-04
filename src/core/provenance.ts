/**
 * Where in its document a chunk comes from, beyond its number. Every part is optional because it depends on
 * the format and on what was known when the document was indexed; nothing here is ever guessed.
 *
 * - PDF: physical page numbers (1-based) and, when the file declares them and the extractor can read them
 *   reliably, the printed page labels ("iii", "7") at the same two pages.
 * - Markdown: the headings from the top level down to the section most of the chunk lies in.
 * - Plain text: nothing; the chunk number is the only place to point at.
 */
export type SourceProvenance = {
  pageStart?: number;
  pageEnd?: number;
  pageLabelStart?: string;
  pageLabelEnd?: string;
  sectionPath?: string[];
};

const MAX_HEADING_CHARS = 60;
const MAX_PATH_CHARS = 140;
const SEPARATOR = " > ";

const shorten = (heading: string) =>
  heading.length > MAX_HEADING_CHARS ? `${heading.slice(0, MAX_HEADING_CHARS - 1)}…` : heading;

/**
 * "Authentication > Refresh tokens". Long headings are shortened, and when the whole path is too long the upper
 * levels are dropped ("… > Section > Leaf") - the section itself is what the reader needs. Plain text.
 */
export function formatSectionPath(path: readonly string[]): string {
  const headings = path.map(shorten);
  let kept = headings.length;
  const render = () => (kept < headings.length ? "… > " : "") + headings.slice(headings.length - kept).join(SEPARATOR);

  while (kept > 1 && render().length > MAX_PATH_CHARS) {
    kept -= 1;
  }
  return render();
}
