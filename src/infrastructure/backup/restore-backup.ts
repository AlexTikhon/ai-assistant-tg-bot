import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ActiveRecipe } from "../../application/assess-index.js";
import { InspectIntegrityUseCase } from "../../application/use-cases/inspect-integrity.use-case.js";
import { ensurePrivateDirectory, ensurePrivateDirectoryAsync, restrictFileAsync } from "../../shared/fs-permissions.js";
import { logger } from "../../shared/logger.js";
import { classifyDatabaseError, openDatabase } from "../sqlite/database.js";
import { LATEST_SCHEMA_VERSION } from "../sqlite/migrations.js";
import { SqliteIndexMaintenance } from "../sqlite/sqlite-index-maintenance.js";
import { SqliteIntegrityStore } from "../sqlite/sqlite-integrity-store.js";
import { LocalFileStorage } from "../storage/local-file-storage.js";
import { DATABASE_FILE, FILES_DIRECTORY, hashFile } from "./manifest.js";
import type { BackupManifest } from "./manifest.js";
import { PREVIOUS_PREFIX, STAGING_PREFIX } from "./restore-artifacts.js";
import { verifyBackup } from "./verify-backup.js";

const log = logger.child({ operation: "restore" });

export type RestoreTarget = { dataDir: string; filesDir: string; sqlitePath: string };

export type RestorePhase = "verify" | "refused" | "prepare" | "activate";

/** Why a restore did not happen. `problems` are the individual findings (for a failed verification, every one of them). */
export class RestoreError extends Error {
  constructor(
    readonly phase: RestorePhase,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "RestoreError";
  }
}

/** What is in the target data directory right now. */
export type LiveInstallation =
  | { state: "absent" }
  /** A database without documents or feedback and no stored files: nothing to lose. */
  | { state: "empty" }
  | { state: "populated"; documents: number; files: number }
  /** A database file SQLite cannot read (damaged, overwritten). It is replaced only on request, and kept. */
  | { state: "unreadable"; reason: string }
  | { state: "in-use" };

export type RestoreStep = "verified" | "staged" | "candidate-ready" | "files-published" | "before-commit";

export type RestoreOptions = {
  /** The backup directory (made by `npm run backup`). Never modified. */
  backupDir: string;
  target: RestoreTarget;
  /** Required to replace a non-empty (or unreadable) installation. Never the default. */
  replaceExisting: boolean;
  /** Remove the replaced installation after a successful restore instead of keeping it. */
  discardPrevious?: boolean;
  /** Prepare and check everything, change nothing, remove the staging area. */
  dryRun?: boolean;
  /** What a current index means (the configured embedding model and chunking): only used to point out outdated documents. */
  recipe: Omit<ActiveRecipe, "embeddingDimension">;
  /** Passed to the migrations of an older backup. */
  legacyEmbeddingModel: string;
  now: () => Date;
  newId?: () => string;
  /** Test seam for fault injection: called after each step of the preparation and just before the commit. Throwing simulates a failure there. */
  hooks?: { at?: (step: RestoreStep) => void | Promise<void> };
};

export type RestoreReport = {
  /** restored: the backup is now the live installation. rehearsed: a dry run; everything was prepared and checked, nothing changed. */
  outcome: "restored" | "rehearsed";
  schema: { backup: number; restored: number };
  documents: number;
  chunks: number;
  files: number;
  warnings: string[];
  live: LiveInstallation["state"];
  /** The state of the target made --replace-existing necessary. */
  requiresReplaceExisting: boolean;
  /** Name (inside the data directory) of the kept copy of the replaced installation; null when there was none or it was discarded. */
  previousInstallation: string | null;
};

/**
 * Restores a backup into a data directory - safely:
 *
 *   verify the backup (read-only)  ->  look at the live installation  ->  stage a candidate  ->  check the candidate  ->  activate
 *
 * Nothing live is touched before the candidate has passed every check, and the candidate is built and migrated in a staging
 * directory INSIDE the data directory (same filesystem, so the last step is a rename):
 *
 * - The backup is verified exactly as `npm run backup:verify` does: manifest, format, hashes, database, integrity.
 * - The database and every file are copied into staging and their SHA-256 is checked again after the copy.
 * - The candidate database is opened with the application's own settings and migrated there if its schema is older (the live
 *   installation is never migrated by a restore), then the full integrity check - including the deep full-text check - runs on it.
 * - An installation that holds data (documents, stored files, or a database SQLite cannot read) is replaced only with
 *   `replaceExisting`. It is not deleted: its database is snapshotted and its files are moved to `.restore-previous-*`.
 *
 * Activation order, and what a failure leaves (the database file is the single commit point):
 *   1. snapshot the live database (SQLite online backup, under an exclusive lock: refuses when the bot is still running)
 *   2. move the staged files into the files directory (names are unique ids; an identical file already there is kept)
 *   3. COMMIT: rename the staged database over app.db - one atomic filesystem operation
 *   4. afterwards, best effort: move files the restored database does not refer to into the previous-installation directory
 * A failure before step 3 is rolled back (files moved in step 2 are removed again, the snapshot is dropped) and the live
 * installation is exactly as it was. A crash (not a failure) before step 3 leaves the live installation untouched plus a
 * `.restore-staging-*` directory, and possibly extra files nothing refers to - both reported by `npm run integrity`. After step 3
 * the restored installation is live; step 4 only tidies.
 */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreReport> {
  const { backupDir, target } = options;
  const at = async (step: RestoreStep) => options.hooks?.at?.(step);

  if ([path.resolve(target.dataDir), path.resolve(target.filesDir)].includes(path.resolve(backupDir))) {
    throw new RestoreError("refused", "The backup directory is the data directory itself; restore from a copy of the backup.");
  }

  // 1. The backup must be sound. Read-only, and nothing below runs when it is not.
  const verification = await verifyBackup(backupDir, { recipe: options.recipe, now: () => options.now().getTime() });
  if (!verification.ok || !verification.manifest) {
    throw new RestoreError("verify", "The backup did not pass verification; nothing was changed.", verification.problems);
  }
  const manifest = verification.manifest;
  const warnings = [...verification.warnings];
  if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) {
    throw new RestoreError("verify", `The backup's database schema ${manifest.schemaVersion} is newer than this application supports (${LATEST_SCHEMA_VERSION}); nothing was changed.`);
  }

  // 2. What would be replaced?
  const live = await inspectLiveInstallation(target);
  if (live.state === "in-use") {
    throw new RestoreError("refused", "The live database is in use by another process (is the bot still running?). Stop it and run the restore again; nothing was changed.");
  }
  const requiresReplaceExisting = live.state === "populated" || live.state === "unreadable";
  if (requiresReplaceExisting && !options.replaceExisting && !options.dryRun) {
    throw new RestoreError("refused", describeRefusal(live));
  }

  // 3. + 4. Stage and check the candidate. Failures here touch nothing but the staging directory, which is removed.
  ensurePrivateDirectory(target.dataDir);
  const id = (options.newId ?? randomUUID)();
  const staging = path.join(target.dataDir, `${STAGING_PREFIX}${id}`);
  const stagedDb = path.join(staging, DATABASE_FILE);
  const stagedFiles = path.join(staging, FILES_DIRECTORY);

  let phase: RestorePhase = "prepare";
  let committed = false;
  let previousDir: string | null = null;
  const publishedFiles: string[] = [];
  let candidate!: { schema: number; documents: number; chunks: number };

  try {
    await at("verified");
    await ensurePrivateDirectoryAsync(stagedFiles);
    await copyChecked(path.join(backupDir, DATABASE_FILE), stagedDb, manifest.database);
    for (const file of manifest.files) {
      await copyChecked(path.join(backupDir, FILES_DIRECTORY, file.storedName), path.join(stagedFiles, file.storedName), file);
    }
    await at("staged");

    candidate = await prepareCandidate({ stagedDb, stagedFiles, manifest, options, warnings });
    await at("candidate-ready");

    if (options.dryRun) {
      await removeQuietly(staging);
      return report("rehearsed");
    }

    // 5. Activate.
    phase = "activate";
    const replacesData = live.state === "populated" || live.state === "unreadable";
    if (replacesData) {
      previousDir = path.join(target.dataDir, `${PREVIOUS_PREFIX}${stamp(options.now())}-${id}`);
      await ensurePrivateDirectoryAsync(path.join(previousDir, FILES_DIRECTORY));
    }
    const released = await releaseLiveDatabase(target.sqlitePath, previousDir ? path.join(previousDir, DATABASE_FILE) : undefined);
    const sidecars = released === "unreadable" ? await moveSidecarsAside(target.sqlitePath, previousDir) : [];

    try {
      await ensurePrivateDirectoryAsync(target.filesDir);
      for (const file of manifest.files) {
        const destination = path.join(target.filesDir, file.storedName);
        const existing = await fs.lstat(destination).catch(() => null);
        if (existing) {
          // Stored names are unique ids and a stored file is never rewritten, so an existing file is the same file - checked, not assumed.
          if (!existing.isFile() || (await hashFile(destination)) !== file.sha256) {
            throw new Error(`The files directory already holds a different file named ${file.storedName}`);
          }
          continue;
        }
        await fs.rename(path.join(stagedFiles, file.storedName), destination);
        publishedFiles.push(destination);
      }
      await at("files-published");
      await at("before-commit");

      await fs.rename(stagedDb, target.sqlitePath); // the commit
      committed = true;
    } catch (error) {
      await moveSidecarsBack(sidecars);
      throw error;
    }

    // The restored installation is live from here on; what follows only tidies and can only produce warnings.
    await restrictFileAsync(target.sqlitePath);
    const moved = await moveUnreferencedFiles(target.filesDir, new Set(manifest.files.map((file) => file.storedName)), previousDir, warnings);
    if (previousDir && options.discardPrevious) {
      await removeQuietly(previousDir);
      previousDir = null;
    } else if (previousDir) {
      warnings.push(`The replaced installation was kept in ${path.basename(previousDir)} (its database and ${moved} files). Remove it once you have checked the restored data.`);
    }
    await removeQuietly(staging);
    log.info({ documents: candidate.documents, files: manifest.files.length, schemaFrom: manifest.schemaVersion, schemaTo: candidate.schema, replaced: replacesData }, "Backup restored");
    return report("restored");
  } catch (error) {
    if (!committed) {
      // Rollback: the live installation was not changed by this attempt.
      for (const file of publishedFiles) await fs.unlink(file).catch(() => undefined);
      if (previousDir) await removeQuietly(previousDir);
      await removeQuietly(staging);
      log.warn({ phase, err: error }, "Restore failed; the live installation was not changed");
    }
    if (error instanceof RestoreError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new RestoreError(
      phase,
      committed
        ? `The restore was committed but finishing it failed: ${detail}`
        : `The restore failed while ${phase === "prepare" ? "preparing the candidate" : "activating it"}: ${detail}. The live installation was not changed.`,
    );
  }

  function report(outcome: RestoreReport["outcome"]): RestoreReport {
    return {
      outcome,
      schema: { backup: manifest.schemaVersion, restored: candidate.schema },
      documents: candidate.documents,
      chunks: candidate.chunks,
      files: manifest.files.length,
      warnings,
      live: live.state,
      requiresReplaceExisting,
      previousInstallation: previousDir ? path.basename(previousDir) : null,
    };
  }
}

function describeRefusal(live: LiveInstallation) {
  const what =
    live.state === "populated"
      ? `The target already holds data (${live.documents} documents, ${live.files} stored files)`
      : live.state === "unreadable"
        ? "The target has a database file that cannot be read"
        : "The target holds an installation";
  return `${what}. Restoring replaces it; add --replace-existing if that is what you want (the replaced installation is kept, not deleted). Nothing was changed.`;
}

/** Looks at the target without changing anything. */
export async function inspectLiveInstallation(target: RestoreTarget): Promise<LiveInstallation> {
  const storedFiles = (await new LocalFileStorage(target.filesDir).list()).filter((entry) => entry.kind === "stored").length;
  const info = await fs.lstat(target.sqlitePath).catch(() => null);

  if (!info || info.size === 0) {
    if (storedFiles > 0) return { state: "populated", documents: 0, files: storedFiles };
    return { state: info ? "empty" : "absent" };
  }

  // A file that does not even start like a SQLite database is not opened with SQLite at all: opening would try to make sense of the
  // write-ahead log beside it and might remove it, and that log is evidence the operator may want.
  if (!(await hasSqliteHeader(target.sqlitePath))) {
    return { state: "unreadable", reason: "the file is not a SQLite database" };
  }

  // A read-only connection to a WAL database leaves empty -wal/-shm files behind; looking must not change the directory.
  const hadWal = await exists(`${target.sqlitePath}-wal`);
  const hadShm = await exists(`${target.sqlitePath}-shm`);
  let db: Database.Database | undefined;
  try {
    db = new Database(target.sqlitePath, { readonly: true, fileMustExist: true });
    db.pragma("busy_timeout = 1000");
    const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    const count = (table: string) => (tables.has(table) ? (db!.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n : 0);
    const documents = count("documents");
    if (documents + count("answer_feedback") + storedFiles === 0) return { state: "empty" };
    return { state: "populated", documents, files: storedFiles };
  } catch (error) {
    const failure = classifyDatabaseError(error);
    if (failure.kind === "locked") return { state: "in-use" };
    return { state: "unreadable", reason: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
    if (!hadWal) await fs.rm(`${target.sqlitePath}-wal`, { force: true }).catch(() => undefined);
    if (!hadShm) await fs.rm(`${target.sqlitePath}-shm`, { force: true }).catch(() => undefined);
  }
}

const exists = (file: string) => fs.lstat(file).then(() => true, () => false);

/** SQLite database files start with the 16 bytes "SQLite format 3\0". */
async function hasSqliteHeader(file: string) {
  const handle = await fs.open(file, "r");
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(16), 0, 16, 0);
    return bytesRead === 16 && buffer.toString("latin1") === "SQLite format 3\u0000";
  } finally {
    await handle.close();
  }
}

/** Copies a file and checks the copy against what the manifest says (a copy that does not match is never used). */
async function copyChecked(source: string, destination: string, expected: { bytes: number; sha256: string }) {
  if (!(await fs.lstat(source)).isFile()) {
    throw new Error(`${path.basename(source)} in the backup is not a regular file`);
  }
  await fs.copyFile(source, destination, constants.COPYFILE_EXCL); // never overwrite
  await restrictFileAsync(destination);
  if ((await fs.stat(destination)).size !== expected.bytes || (await hashFile(destination)) !== expected.sha256) {
    throw new Error(`${path.basename(destination)} did not match the manifest after it was copied`);
  }
}

type CandidateInputs = {
  stagedDb: string;
  stagedFiles: string;
  manifest: BackupManifest;
  options: RestoreOptions;
  warnings: string[];
};

/**
 * Opens the staged database with the application's settings (which migrates an older schema - here, never in the live
 * installation) and runs the complete integrity check on it. Throws, listing every error, when the candidate is not sound.
 */
async function prepareCandidate({ stagedDb, stagedFiles, manifest, options, warnings }: CandidateInputs) {
  let db: Database.Database;
  try {
    db = openDatabase(stagedDb, { legacyEmbeddingModel: options.legacyEmbeddingModel });
  } catch (error) {
    throw new RestoreError("prepare", `The backup's database could not be opened or migrated: ${error instanceof Error ? error.message : String(error)}. The live installation was not changed.`);
  }

  try {
    const schema = db.pragma("user_version", { simple: true }) as number;
    if (schema !== manifest.schemaVersion) {
      warnings.push(`The backup's database (schema ${manifest.schemaVersion}) was migrated to schema ${schema} before it was activated.`);
    }

    // Documents whose original file was already missing when the backup was made are expected to have no file.
    const missingNames = new Set(manifest.missingFiles);
    const missingDocuments = new Set(
      (db.prepare("SELECT id, stored_name AS storedName FROM documents").all() as Array<{ id: string; storedName: string }>).filter((row) => missingNames.has(row.storedName)).map((row) => row.id),
    );

    const integrity = await new InspectIntegrityUseCase({
      store: new SqliteIntegrityStore(db),
      maintenance: new SqliteIndexMaintenance(db),
      files: new LocalFileStorage(stagedFiles),
      recipe: options.recipe,
      now: () => options.now().getTime(),
      verifyHashes: true,
      deepFullText: true,
    }).execute();

    const errors = integrity.issues.filter(
      (issue) => issue.severity === "error" && !(issue.code === "missing-file" && issue.documentId && missingDocuments.has(issue.documentId)),
    );
    if (errors.length > 0) {
      throw new RestoreError("prepare", "The restored database failed the integrity check; the live installation was not changed.", errors.map((issue) => `${issue.code}: ${issue.message}`));
    }
    for (const issue of integrity.issues.filter((item) => item.severity === "warning" && item.code !== "orphan-file")) {
      warnings.push(`${issue.code}: ${issue.message}`);
    }

    db.pragma("wal_checkpoint(TRUNCATE)");
    return { schema, documents: integrity.summary.documents, chunks: integrity.summary.chunks };
  } finally {
    db.close();
    // A standalone file: closing the last connection removes the -wal and -shm files; make sure none is left to be mistaken for live data.
    await fs.rm(`${stagedDb}-wal`, { force: true });
    await fs.rm(`${stagedDb}-shm`, { force: true });
  }
}

/**
 * Takes the live database out of service for the swap: an exclusive lock proves that no other process (the bot) has it open, the
 * snapshot is taken under that lock, and closing the connection checkpoints and removes the -wal and -shm files, so no stale
 * write-ahead log can ever meet the restored file.
 * `unreadable`: the file cannot be opened by SQLite; it is copied as it is (evidence) and its sidecars are handled by the caller.
 */
async function releaseLiveDatabase(sqlitePath: string, snapshotTo: string | undefined): Promise<"released" | "unreadable" | "absent"> {
  if (!(await fs.lstat(sqlitePath).catch(() => null))) {
    return "absent";
  }

  if (!(await hasSqliteHeader(sqlitePath))) {
    if (snapshotTo) await fs.copyFile(sqlitePath, snapshotTo);
    return "unreadable";
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(sqlitePath, { fileMustExist: true });
    db.pragma("busy_timeout = 2000");
    db.pragma("locking_mode = EXCLUSIVE");
    db.prepare("SELECT COUNT(*) FROM sqlite_master").get(); // the first read takes the exclusive lock
    db.pragma("wal_checkpoint(TRUNCATE)");
    if (snapshotTo) {
      await db.backup(snapshotTo);
      await restrictFileAsync(snapshotTo);
    }
    return "released";
  } catch (error) {
    const failure = classifyDatabaseError(error);
    if (failure.kind === "locked") {
      throw new RestoreError("refused", "The live database is in use by another process (is the bot still running?). Stop it and run the restore again; nothing was changed.");
    }
    if (failure.kind === "corrupt" || failure.kind === "not-a-database") {
      db?.close();
      db = undefined;
      if (snapshotTo) await fs.copyFile(sqlitePath, snapshotTo);
      return "unreadable";
    }
    throw error;
  } finally {
    db?.close();
  }
}

/** For an unreadable live database: its -wal/-shm files must not meet the restored file, so they go with it into the previous-installation directory. */
async function moveSidecarsAside(sqlitePath: string, previousDir: string | null) {
  const moved: Array<{ from: string; to: string }> = [];
  for (const suffix of ["-wal", "-shm"]) {
    const from = `${sqlitePath}${suffix}`;
    if (!(await fs.lstat(from).catch(() => null))) continue;
    const to = previousDir ? path.join(previousDir, `${DATABASE_FILE}${suffix}`) : `${from}.discarded`;
    await fs.rename(from, to);
    moved.push({ from, to });
  }
  return moved;
}

async function moveSidecarsBack(moved: Array<{ from: string; to: string }>) {
  for (const { from, to } of moved) await fs.rename(to, from).catch(() => undefined);
}

/** After the commit: stored files the restored database does not refer to leave the files directory (kept in the previous-installation directory). */
async function moveUnreferencedFiles(filesDir: string, keep: ReadonlySet<string>, previousDir: string | null, warnings: string[]) {
  let moved = 0;
  try {
    for (const entry of await new LocalFileStorage(filesDir).list()) {
      if (entry.kind !== "stored" || keep.has(entry.name)) continue;
      if (!previousDir) {
        warnings.push(`The files directory holds ${entry.name}, which the restored database does not refer to; \`npm run integrity\` lists such files.`);
        continue;
      }
      await fs.rename(path.join(filesDir, entry.name), path.join(previousDir, FILES_DIRECTORY, entry.name));
      moved += 1;
    }
  } catch (error) {
    warnings.push(`Files of the replaced installation could not all be moved aside (${error instanceof Error ? error.message : String(error)}); \`npm run integrity\` lists them.`);
  }
  return moved;
}

const stamp = (date: Date) => date.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");

async function removeQuietly(directory: string) {
  await fs.rm(directory, { recursive: true, force: true }).catch((error) => log.warn({ err: error }, "Could not remove a restore working directory; npm run integrity lists it"));
}
