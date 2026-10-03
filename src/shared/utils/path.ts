import path from "node:path";

const MAX_BASE_NAME_LENGTH = 100;

/** Returns the lowercase file extension including the leading dot. */
export function getFileExtension(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

/** Sanitizes a user-supplied file name so it is safe and reasonably short on disk. */
export function getSafeFileName(fileName: string) {
  const extension = getFileExtension(fileName);
  const base = path
    .basename(fileName, path.extname(fileName))
    .replace(/[^\w-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_BASE_NAME_LENGTH);

  return `${base || "document"}${extension.replace(/[^\w.]/g, "")}`;
}
