import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileStorage } from "../../application/ports/file-storage.js";
import type { StorageEntry } from "../../core/storage-layout.js";
import { getSafeFileName } from "../../shared/utils/path.js";

/** Writes go to `.tmp-<uuid>-<name>.part` first and are renamed into place; nothing else uses this shape. */
const TEMP_PREFIX = ".tmp-";
const TEMP_SUFFIX = ".part";

const isTemporaryName = (name: string) => name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX);

/** Stores original uploads on the local disk under UUID-prefixed, sanitized names. */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly directory: string) {}

  async save(fileName: string, data: Buffer) {
    await fs.mkdir(this.directory, { recursive: true });

    const storedName = `${randomUUID()}-${getSafeFileName(fileName)}`;
    const temporaryPath = path.join(this.directory, `${TEMP_PREFIX}${storedName}${TEMP_SUFFIX}`);

    try {
      // "wx": never overwrite an existing file. Written beside the target so the rename stays on one filesystem (atomic).
      await fs.writeFile(temporaryPath, data, { flag: "wx" });
      await fs.rename(temporaryPath, path.join(this.directory, storedName));
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    return storedName;
  }

  async read(storedName: string) {
    return fs.readFile(this.resolve(storedName));
  }

  async delete(storedName: string) {
    await unlinkIfPresent(this.resolve(storedName));
  }

  async stat(storedName: string) {
    try {
      return { size: (await fs.stat(this.resolve(storedName))).size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async list(): Promise<StorageEntry[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const entries: StorageEntry[] = [];
    for (const name of names) {
      try {
        const info = await fs.stat(path.join(this.directory, name));
        if (info.isFile()) {
          entries.push({ name, kind: isTemporaryName(name) ? "temporary" : "stored", size: info.size, modifiedAtMs: info.mtimeMs });
        }
      } catch (error) {
        // Removed while listing (e.g. a write finishing): it is simply no longer there.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
    return entries;
  }

  async deleteTemporary(name: string) {
    const target = this.resolve(name);
    if (!isTemporaryName(name)) {
      throw new Error(`${name} is not a temporary file`);
    }
    await unlinkIfPresent(target);
  }

  /** storedName comes from the database; refuse anything that is not a plain file name. */
  private resolve(storedName: string) {
    if (path.basename(storedName) !== storedName) {
      throw new Error("Invalid stored file name");
    }
    return path.join(this.directory, storedName);
  }
}

async function unlinkIfPresent(target: string) {
  try {
    await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
