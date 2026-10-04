import type { StorageEntry } from "../../core/storage-layout.js";

/** Storage for the original uploaded files. */
export interface FileStorage {
  /**
   * Persists the file and returns the opaque name it can later be deleted by. The write is atomic: a
   * crash leaves either the complete file or a recognisable temporary leftover, never a truncated file.
   */
  save(fileName: string, data: Buffer): Promise<string>;
  /** The bytes of a stored file. Throws when it does not exist. */
  read(storedName: string): Promise<Buffer>;
  /** Deletes a stored file; a missing file is not an error. */
  delete(storedName: string): Promise<void>;
  /** Size of a stored file without reading it; null when it does not exist. */
  stat(storedName: string): Promise<{ size: number } | null>;
  /** Everything in the storage - committed files and temporary leftovers - for integrity checks and cleanup. */
  list(): Promise<StorageEntry[]>;
  /** Deletes a temporary leftover (and nothing else). A missing file is not an error. */
  deleteTemporary(name: string): Promise<void>;
}
