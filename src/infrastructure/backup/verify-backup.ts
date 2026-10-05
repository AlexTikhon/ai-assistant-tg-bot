import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import type { ActiveRecipe } from "../../application/assess-index.js";
import { InspectIntegrityUseCase } from "../../application/use-cases/inspect-integrity.use-case.js";
import type { IntegrityReport } from "../../application/use-cases/inspect-integrity.use-case.js";
import { openDatabaseReadOnly } from "../sqlite/database.js";
import { LATEST_SCHEMA_VERSION } from "../sqlite/migrations.js";
import { SqliteIndexMaintenance } from "../sqlite/sqlite-index-maintenance.js";
import { SqliteIntegrityStore } from "../sqlite/sqlite-integrity-store.js";
import { LocalFileStorage } from "../storage/local-file-storage.js";
import { APPLICATION_NAME, classifyBackupFormat, DATABASE_FILE, FILES_DIRECTORY, hashFile, MANIFEST_FILE, parseManifest } from "./manifest.js";
import type { BackupManifest } from "./manifest.js";

export type BackupVerification = {
  /** True when no problem was found. Warnings do not fail a backup. */
  ok: boolean;
  problems: string[];
  warnings: string[];
  manifest?: BackupManifest;
  checked: { documents: number; files: number };
  /** The integrity checks run on the backup copy; absent when the schema is not the current one. */
  integrity?: IntegrityReport;
};

type VerifyOptions = {
  /** The recipe a current index means; only used to point out stale documents. */
  recipe: Omit<ActiveRecipe, "embeddingDimension">;
  now: () => number;
};

/**
 * Checks that a backup directory is complete and intact, without modifying it:
 *
 * - the manifest is present, valid and of a format this version understands,
 * - the database file and every original file exist and match the manifest's size and SHA-256,
 * - the database opens read-only, passes SQLite's structural check and has the documents the manifest says,
 * - every document's file is in the backup (or was already recorded as missing when it was made),
 * - recorded content hashes agree with the files,
 * - and the same integrity checks as `npm run integrity` run on the copy.
 *
 * It never reads the live installation and never calls any provider.
 */
export async function verifyBackup(directory: string, options: VerifyOptions): Promise<BackupVerification> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const checked = { documents: 0, files: 0 };
  const fail = (manifest?: BackupManifest): BackupVerification => ({ ok: false, problems, warnings, manifest, checked });

  let manifestText: string;
  try {
    manifestText = await fs.readFile(path.join(directory, MANIFEST_FILE), "utf-8");
  } catch {
    problems.push(`No ${MANIFEST_FILE} in ${directory}: this is not a finished backup (the manifest is written last).`);
    return fail();
  }

  let manifest: BackupManifest;
  try {
    manifest = parseManifest(manifestText);
  } catch (error) {
    problems.push(error instanceof Error ? error.message.replace(/^./, (c) => c.toUpperCase()) : String(error));
    return fail();
  }
  const format = classifyBackupFormat(manifest.formatVersion);
  if (format.kind !== "supported") {
    problems.push(format.message);
    return fail(manifest);
  }
  if (manifest.application.name !== APPLICATION_NAME) {
    problems.push(`This is a backup of "${manifest.application.name}", not of ${APPLICATION_NAME}.`);
    return fail(manifest);
  }

  const databasePath = path.join(directory, DATABASE_FILE);
  const filesPath = path.join(directory, FILES_DIRECTORY);

  // The files listed in the manifest.
  const known = new Map(manifest.files.map((file) => [file.storedName, file]));
  for (const file of manifest.files) {
    if (path.basename(file.storedName) !== file.storedName) {
      problems.push(`The manifest lists an invalid file name: ${file.storedName}`);
      continue;
    }
    const target = path.join(filesPath, file.storedName);
    const info = await fs.lstat(target).catch(() => null);
    if (!info) {
      problems.push(`File missing from the backup: ${file.storedName}`);
      continue;
    }
    if (!info.isFile()) {
      problems.push(`${file.storedName} in the backup is not a regular file (a link is never followed).`);
      continue;
    }
    checked.files += 1;
    if (info.size !== file.bytes) {
      problems.push(`File size mismatch: ${file.storedName} has ${info.size} bytes, the manifest says ${file.bytes}.`);
    } else if ((await hashFile(target)) !== file.sha256) {
      problems.push(`File hash mismatch: ${file.storedName} was changed after the backup was made.`);
    }
  }
  if (manifest.counts.files !== manifest.files.length) {
    problems.push(`The manifest counts ${manifest.counts.files} files but lists ${manifest.files.length}.`);
  }
  for (const name of manifest.missingFiles) {
    warnings.push(`${name} was already missing from storage when the backup was made.`);
  }
  for (const entry of await fs.readdir(filesPath).catch(() => [] as string[])) {
    if (!known.has(entry)) {
      warnings.push(`The backup contains a file the manifest does not list: ${entry}`);
    }
  }

  // The database file.
  const databaseInfo = await fs.lstat(databasePath).catch(() => null);
  if (!databaseInfo || !databaseInfo.isFile()) {
    problems.push(`The database file ${DATABASE_FILE} is missing from the backup.`);
    return fail(manifest);
  }
  if (databaseInfo.size !== manifest.database.bytes || (await hashFile(databasePath)) !== manifest.database.sha256) {
    problems.push("The database file does not match the manifest (size or hash): it was changed after the backup was made.");
    return fail(manifest);
  }

  let db: Database.Database;
  try {
    db = openDatabaseReadOnly(databasePath, { requireCurrentSchema: false });
  } catch (error) {
    problems.push(`The database cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
    return fail(manifest);
  }

  try {
    const quick = db.pragma("quick_check") as Array<{ quick_check: string }>;
    for (const row of quick.filter((item) => item.quick_check !== "ok")) {
      problems.push(`The database failed SQLite's structural check: ${row.quick_check}`);
    }

    const schemaVersion = db.pragma("user_version", { simple: true }) as number;
    if (schemaVersion !== manifest.schemaVersion) {
      problems.push(`The database has schema version ${schemaVersion}, the manifest says ${manifest.schemaVersion}.`);
    }
    if (schemaVersion > LATEST_SCHEMA_VERSION) {
      problems.push(`The database schema ${schemaVersion} is newer than this application supports (${LATEST_SCHEMA_VERSION}).`);
      return { ok: false, problems, warnings, manifest, checked };
    }

    const documents = db.prepare("SELECT id, stored_name AS storedName, content_hash AS contentHash FROM documents").all() as Array<{ id: string; storedName: string; contentHash: string | null }>;
    checked.documents = documents.length;
    if (documents.length !== manifest.counts.documents) {
      problems.push(`The database holds ${documents.length} documents, the manifest says ${manifest.counts.documents}.`);
    }

    const missing = new Set(manifest.missingFiles);
    const missingDocumentIds = new Set<string>();
    for (const document of documents) {
      const file = known.get(document.storedName);
      if (!file) {
        if (missing.has(document.storedName)) {
          missingDocumentIds.add(document.id);
        } else {
          problems.push(`Document ${document.id} refers to ${document.storedName}, which is neither in the backup nor recorded as missing.`);
        }
        continue;
      }
      if (document.contentHash !== null && document.contentHash !== file.sha256) {
        problems.push(`Document ${document.id}: the recorded content hash does not match its file ${document.storedName}.`);
      }
    }

    if (schemaVersion === LATEST_SCHEMA_VERSION) {
      const integrity = await new InspectIntegrityUseCase({
        store: new SqliteIntegrityStore(db),
        maintenance: new SqliteIndexMaintenance(db),
        files: new LocalFileStorage(filesPath),
        recipe: options.recipe,
        now: options.now,
        verifyHashes: false, // the file hashes were verified against the manifest above
        deepFullText: true,
      }).execute();

      for (const issue of integrity.issues) {
        if (issue.severity === "error" && issue.code === "missing-file" && issue.documentId && missingDocumentIds.has(issue.documentId)) {
          continue; // already reported as a warning above
        }
        if (issue.severity === "error") {
          problems.push(`${issue.code}: ${issue.message}`);
        }
      }
      return { ok: problems.length === 0, problems, warnings, manifest, checked, integrity };
    }

    warnings.push(
      `The backup's schema (version ${schemaVersion}) is older than this application's (${LATEST_SCHEMA_VERSION}): the data checks were skipped. Starting the bot migrates it after a restore.`,
    );
    return { ok: problems.length === 0, problems, warnings, manifest, checked };
  } finally {
    db.close();
  }
}
