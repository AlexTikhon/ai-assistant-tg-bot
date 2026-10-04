/** Storage for the original uploaded files. */
export interface FileStorage {
  /** Persists the file and returns the opaque name it can later be deleted by. */
  save(fileName: string, data: Buffer): Promise<string>;
  /** The bytes of a stored file. Throws when it does not exist. */
  read(storedName: string): Promise<Buffer>;
  /** Deletes a stored file; a missing file is not an error. */
  delete(storedName: string): Promise<void>;
}
