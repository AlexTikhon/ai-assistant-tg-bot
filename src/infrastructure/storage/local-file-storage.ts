import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileStorage } from "../../application/ports/file-storage.js";
import { SUPPORTED_EXTENSIONS } from "../../core/document.js";
import type { StorageEntry } from "../../core/storage-layout.js";
import { ensurePrivateDirectoryAsync, PRIVATE_FILE_MODE } from "../../shared/fs-permissions.js";
import { storedFileExtension } from "../../shared/utils/path.js";

/** Writes go to `.tmp-<uuid>.part` first and are renamed into place; nothing else uses this shape. */
const TEMP_PREFIX = ".tmp-";
const TEMP_SUFFIX = ".part";

const isTemporaryName = (name: string) => name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX);

/** What a stored name can look like: the names this application ever generated (including the older `<uuid>-<sanitized name>.<ext>`). */
const STORED_NAME = /^[A-Za-z0-9_.-]{1,255}$/;

/**
 * Stores original uploads on the local disk.
 *
 * The name of a stored file is generated here: `<uuid><extension>`, where the extension is one of the accepted formats or empty.
 * The user's file name is never part of a path - it is metadata in the database - so no name an upload carries
 * (`../../x`, `C:\x`, `con.txt`, NUL bytes, 5000 characters) can select, overwrite or escape to a file.
 * Names coming back from the database are validated again before they touch the file system, and a symbolic link in the
 * storage directory is never followed.
 */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly directory: string) {}

  async save(fileName: string, data: Buffer) {
    await ensurePrivateDirectoryAsync(this.directory);

    const storedName = `${randomUUID()}${storedFileExtension(fileName, SUPPORTED_EXTENSIONS)}`;
    const temporaryPath = path.join(this.directory, `${TEMP_PREFIX}${randomUUID()}${TEMP_SUFFIX}`);

    try {
      // "wx": never overwrite an existing file (and never follow a link planted at that path). Written beside the target so the rename stays on one filesystem (atomic).
      await fs.writeFile(temporaryPath, data, { flag: "wx", mode: PRIVATE_FILE_MODE });
      await fs.rename(temporaryPath, path.join(this.directory, storedName));
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }

    return storedName;
  }

  async read(storedName: string) {
    const target = this.resolve(storedName);
    await this.assertNotLink(target);
    return fs.readFile(target);
  }

  async delete(storedName: string) {
    // Unlinking removes a link itself and never touches what it points to.
    await unlinkIfPresent(this.resolve(storedName));
  }

  async stat(storedName: string) {
    try {
      const info = await fs.lstat(this.resolve(storedName));
      // A link (or anything that is not a regular file) is not a stored original.
      return info.isFile() ? { size: info.size } : null;
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
        const info = await fs.lstat(path.join(this.directory, name));
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

  /** storedName comes from the database; refuse anything that is not a plain file name made of safe characters. */
  private resolve(storedName: string) {
    if (!STORED_NAME.test(storedName) || storedName === "." || storedName === ".." || path.basename(storedName) !== storedName) {
      throw new Error("Invalid stored file name");
    }
    return path.join(this.directory, storedName);
  }

  private async assertNotLink(target: string) {
    const info = await fs.lstat(target); // ENOENT propagates: a missing file is reported as missing
    if (!info.isFile()) {
      throw new Error("The stored file is not a regular file");
    }
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
