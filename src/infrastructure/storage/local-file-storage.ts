import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FileStorage } from "../../application/ports/file-storage.js";
import { getSafeFileName } from "../../shared/utils/path.js";

/** Stores original uploads on the local disk under UUID-prefixed, sanitized names. */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly directory: string) {}

  async save(fileName: string, data: Buffer) {
    await fs.mkdir(this.directory, { recursive: true });

    const storedName = `${randomUUID()}-${getSafeFileName(fileName)}`;
    // "wx": never overwrite an existing file.
    await fs.writeFile(path.join(this.directory, storedName), data, { flag: "wx" });

    return storedName;
  }

  async read(storedName: string) {
    return fs.readFile(this.resolve(storedName));
  }

  async delete(storedName: string) {
    try {
      await fs.unlink(this.resolve(storedName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  /** storedName comes from the database; refuse anything that is not a plain file name. */
  private resolve(storedName: string) {
    if (path.basename(storedName) !== storedName) {
      throw new Error("Invalid stored file name");
    }
    return path.join(this.directory, storedName);
  }
}
