import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root, independent of the directory the tests are started from. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
