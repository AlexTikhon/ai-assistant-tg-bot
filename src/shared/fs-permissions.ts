import fs from "node:fs";
import fsp from "node:fs/promises";

/**
 * Permissions of what the application creates. User documents and the database are private to the account
 * that runs the bot: directories 0700, files 0600. (On Windows these modes are largely ignored; the rule
 * matters for Linux hosts and containers.)
 */
export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Best effort: a filesystem without POSIX modes (a Windows or FAT bind mount) must not stop the application. */
export function restrictFile(filePath: string) {
  try {
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch {
    // not supported here
  }
}

export async function restrictFileAsync(filePath: string) {
  await fsp.chmod(filePath, PRIVATE_FILE_MODE).catch(() => undefined);
}

export function restrictDirectory(directory: string) {
  try {
    fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  } catch {
    // not supported here
  }
}

/** Creates the directory (and parents) if needed. Only directories created by this call get the private mode. */
export function ensurePrivateDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}

export async function ensurePrivateDirectoryAsync(directory: string) {
  await fsp.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}
