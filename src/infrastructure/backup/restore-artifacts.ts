import fs from "node:fs/promises";
import path from "node:path";
import type { RestoreArtifact, RestoreArtifacts } from "../../application/ports/restore-artifacts.js";

/** Both live inside the data directory, on the same filesystem as the database, so that the final step is a rename. */
export const STAGING_PREFIX = ".restore-staging-";
export const PREVIOUS_PREFIX = ".restore-previous-";

const kindOf = (name: string): RestoreArtifact["kind"] | null =>
  name.startsWith(STAGING_PREFIX) ? "staging" : name.startsWith(PREVIOUS_PREFIX) ? "previous-installation" : null;

/** The restore leftovers in one data directory. */
export class DataDirectoryRestoreArtifacts implements RestoreArtifacts {
  constructor(private readonly dataDir: string) {}

  async list(): Promise<RestoreArtifact[]> {
    const names = await fs.readdir(this.dataDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });

    const artifacts: RestoreArtifact[] = [];
    for (const name of names) {
      const kind = kindOf(name);
      if (!kind) continue;
      const info = await fs.lstat(path.join(this.dataDir, name)).catch(() => null);
      if (info?.isDirectory()) {
        artifacts.push({ name, kind, modifiedAtMs: info.mtimeMs });
      }
    }
    return artifacts.sort((a, b) => a.name.localeCompare(b.name));
  }

  async remove(name: string) {
    if (path.basename(name) !== name || kindOf(name) === null) {
      throw new Error(`${name} is not a restore artifact`);
    }
    await fs.rm(path.join(this.dataDir, name), { recursive: true, force: true });
  }
}
