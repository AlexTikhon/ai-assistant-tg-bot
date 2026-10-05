import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePrivateDirectoryAsync, PRIVATE_FILE_MODE, restrictFileAsync } from "../../shared/fs-permissions.js";
import { logger } from "../../shared/logger.js";
import { APPLICATION_NAME, BACKUP_FORMAT_VERSION, DATABASE_FILE, FILES_DIRECTORY, hashFile, MANIFEST_FILE } from "./manifest.js";
import type { BackupManifest } from "./manifest.js";

export type CreateBackupOptions = {
  /** The snapshot connection may be read-only; a separate write barrier needs write access to its database file. */
  db: Database.Database;
  /** Where the original uploads are stored. */
  filesDir: string;
  /** The backup directory to create. Must not exist or must be empty. */
  outputDir: string;
  now: () => Date;
  applicationVersion: string;
  /** Explicit disaster recovery only: preserve a damaged installation with missing originals. */
  allowIncomplete?: boolean;
};

const log = logger.child({ operation: "backup" });

/**
 * Writes a restorable copy of the local installation into `outputDir`:
 *
 *   app.db          a consistent snapshot made with SQLite's online backup API
 *   files/<name>    the original files the snapshot refers to
 *   manifest.json   what is in it, with hashes (written last: its presence means the backup is complete)
 *
 * That is all it ever writes. Configuration (.env), API keys, the bot token and logs are not part of the
 * data directory's contents this function touches, so they cannot end up in a backup.
 *
 * The database is NOT copied as a file: a live database in WAL mode keeps recent commits in a separate -wal
 * file that a plain copy would miss or tear. The backup API reads a point-in-time snapshot through SQLite
 * itself. A separate connection holds BEGIN IMMEDIATE through snapshotting and file copying: document
 * mutations cannot commit and remove originals while the snapshot still needs them. Reads remain available.
 *
 * On any failure everything this call created is removed again, so a half-written backup never exists.
 */
export async function createBackup(options: CreateBackupOptions): Promise<BackupManifest> {
  const { db, filesDir, outputDir } = options;

  const existed = await fs.stat(outputDir).then(
    (info) => info.isDirectory(),
    () => false,
  );
  if (existed && (await fs.readdir(outputDir)).length > 0) {
    throw new Error(`The backup directory ${outputDir} is not empty; choose a new one.`);
  }

  // A backup holds users' documents: readable by its owner only.
  await ensurePrivateDirectoryAsync(path.join(outputDir, FILES_DIRECTORY));

  let barrier: Database.Database | undefined;
  try {
    if (db.name === ":memory:" || db.inTransaction) {
      throw new Error("Backup requires a file database outside an active transaction.");
    }
    barrier = new Database(db.name, { fileMustExist: true });
    barrier.pragma("busy_timeout = 2000");
    barrier.exec("BEGIN IMMEDIATE");
    const databasePath = path.join(outputDir, DATABASE_FILE);
    await db.backup(databasePath);
    await restrictFileAsync(databasePath);

    const snapshot = readSnapshot(databasePath);
    const files: BackupManifest["files"] = [];
    const missingFiles: string[] = [];

    for (const storedName of snapshot.storedNames) {
      if (path.basename(storedName) !== storedName) {
        throw new Error("Invalid stored file name");
      }
      const target = path.join(outputDir, FILES_DIRECTORY, storedName);
      try {
        const source = path.join(filesDir, storedName);
        // A link in the storage directory is never followed: copying it would put some other file of the machine into the backup.
        if (!(await fs.lstat(source)).isFile()) {
          throw new Error(`Stored file ${storedName} is not a regular file`);
        }
        await fs.copyFile(source, target);
        await restrictFileAsync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          missingFiles.push(storedName);
          continue;
        }
        throw error;
      }
      files.push({ storedName, bytes: (await fs.stat(target)).size, sha256: await hashFile(target) });
    }

    if (missingFiles.length > 0 && !options.allowIncomplete) {
      throw new Error(`Backup is incomplete: ${missingFiles.length} original files are missing. Use --allow-incomplete only for partial recovery.`);
    }

    const manifest: BackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: options.now().toISOString(),
      application: { name: APPLICATION_NAME, version: options.applicationVersion },
      schemaVersion: snapshot.schemaVersion,
      database: { file: DATABASE_FILE, bytes: (await fs.stat(databasePath)).size, sha256: await hashFile(databasePath) },
      counts: { documents: snapshot.documents, chunks: snapshot.chunks, files: files.length },
      files,
      missingFiles,
      indexProfiles: snapshot.indexProfiles,
    };

    // Last, and atomically: a directory without manifest.json is not a finished backup.
    const manifestPath = path.join(outputDir, MANIFEST_FILE);
    await fs.writeFile(`${manifestPath}.tmp`, JSON.stringify(manifest, null, 2), { mode: PRIVATE_FILE_MODE });
    await fs.rename(`${manifestPath}.tmp`, manifestPath);

    log.info({ documents: manifest.counts.documents, files: files.length, missingFiles: missingFiles.length }, "Backup created");
    return manifest;
  } catch (error) {
    await removeCreated(outputDir, existed);
    throw error;
  } finally {
    if (barrier) {
      try { if (barrier.inTransaction) barrier.exec("ROLLBACK"); }
      finally { barrier.close(); }
    }
  }
}

/** Reads the facts the manifest needs from the snapshot itself, and makes the snapshot a standalone file. */
function readSnapshot(databasePath: string) {
  const snapshot = new Database(databasePath);
  try {
    // The snapshot inherits WAL mode; a standalone file needs no -wal/-shm beside it.
    snapshot.pragma("journal_mode = DELETE");

    const schemaVersion = snapshot.pragma("user_version", { simple: true }) as number;
    const count = (table: string) => (snapshot.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const columns = (snapshot.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>).map((column) => column.name);

    const indexProfiles = columns.includes("index_fingerprint")
      ? (snapshot.prepare("SELECT index_fingerprint AS fingerprint, index_profile AS profile, COUNT(*) AS documents FROM documents GROUP BY index_fingerprint, index_profile").all() as Array<{ fingerprint: string | null; profile: string | null; documents: number }>).map(
          (row) => ({ fingerprint: row.fingerprint, profile: parseJson(row.profile), documents: row.documents }),
        )
      : [];

    return {
      schemaVersion,
      documents: count("documents"),
      chunks: count("document_chunks"),
      storedNames: (snapshot.prepare("SELECT stored_name AS name FROM documents ORDER BY created_at, id").all() as Array<{ name: string }>).map((row) => row.name),
      indexProfiles,
    };
  } finally {
    snapshot.close();
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Removes what this call created: the whole directory if it made it, otherwise only the contents (it was empty). */
async function removeCreated(outputDir: string, existed: boolean) {
  try {
    if (!existed) {
      await fs.rm(outputDir, { recursive: true, force: true });
      return;
    }
    for (const entry of await fs.readdir(outputDir)) {
      await fs.rm(path.join(outputDir, entry), { recursive: true, force: true });
    }
  } catch (err) {
    log.warn({ err }, "Could not remove the incomplete backup");
  }
}
