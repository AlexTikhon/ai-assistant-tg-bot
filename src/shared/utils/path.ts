import path from "node:path";

/** Returns the lowercase file extension including the leading dot. */
export function getFileExtension(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

/**
 * The extension a stored file gets: only one of the formats the application accepts, else none. A user-supplied name never reaches
 * the file system in any other form - stored files are named `<uuid><extension>` (see LocalFileStorage).
 */
export function storedFileExtension(fileName: string, allowed: ReadonlySet<string>) {
  const extension = getFileExtension(fileName);
  return allowed.has(extension) ? extension : "";
}
