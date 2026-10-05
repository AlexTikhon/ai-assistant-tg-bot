import { createRequire } from "node:module";

function readVersion() {
  try {
    // package.json sits two levels above src/shared and dist/shared, so one path works under tsx and from compiled code.
    // (createRequire rather than an import: the file is outside the compiler's rootDir.)
    const manifest = createRequire(import.meta.url)("../../package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** The package.json version: the one place the application version comes from. */
export const APPLICATION_VERSION = readVersion();
