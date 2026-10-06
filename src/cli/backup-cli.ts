import { describeErrorSafely } from "../shared/scrub.js";
import { parseArgs } from "node:util";
import path from "node:path";
import type { BackupManifest } from "../infrastructure/backup/manifest.js";
import type { BackupVerification } from "../infrastructure/backup/verify-backup.js";

export const BACKUP_USAGE = `Writes a restorable copy of the local installation into a new directory:

  app.db          a consistent snapshot of the database (writes pause until originals are copied)
  files/          the original uploaded files the snapshot refers to
  manifest.json   schema version, counts, index profiles, sizes and SHA-256 of everything

Usage: npm run backup -- [--output <directory>]

  --output <dir>   where to write (must not exist or be empty); default ./backups/bot-backup-<timestamp>
  --allow-incomplete   explicitly preserve missing originals as a partial recovery backup
  --help           show this help

A backup never includes .env, API keys, the bot token or logs. Check one with: npm run backup:verify -- <directory>
To restore one: stop the bot, then run: npm run restore -- --from <directory>  (add --dry-run to rehearse it, --replace-existing to replace an installation that holds data).`;

export const VERIFY_USAGE = `Checks that a backup is complete and intact. It does not modify the backup or touch the live installation.

Usage: npm run backup:verify -- <backup-directory>
  --allow-incomplete   explicitly accept originals recorded as missing (partial recovery only)

Verifies the manifest, the database and every original file (size and SHA-256), that the database opens and
passes SQLite's structural check, that every document's file is present, that recorded content hashes agree,
and runs the integrity checks of \`npm run integrity\` on the copy. Exit code 1 when a problem is found.`;

export type BackupCommand = { kind: "run"; output: string | undefined; allowIncomplete?: boolean } | { kind: "help" } | { kind: "error"; message: string };
export type VerifyCommand = { kind: "run"; directory: string; allowIncomplete?: boolean } | { kind: "help" } | { kind: "error"; message: string };


export function parseBackupArgs(argv: string[]): BackupCommand {
  try {
    const { values } = parseArgs({ args: argv, options: { output: { type: "string" }, "allow-incomplete": { type: "boolean" }, help: { type: "boolean" } }, strict: true, allowPositionals: false });
    return values.help ? { kind: "help" } : { kind: "run", output: values.output, ...(values["allow-incomplete"] ? { allowIncomplete: true } : {}) };
  } catch (error) {
    return { kind: "error", message: describeErrorSafely(error) };
  }
}

export function parseVerifyArgs(argv: string[]): VerifyCommand {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { "allow-incomplete": { type: "boolean" }, help: { type: "boolean" } }, strict: true, allowPositionals: true });
    if (values.help) return { kind: "help" };
    if (positionals.length !== 1) return { kind: "error", message: "Give exactly one backup directory." };
    return { kind: "run", directory: positionals[0], ...(values["allow-incomplete"] ? { allowIncomplete: true } : {}) };
  } catch (error) {
    return { kind: "error", message: describeErrorSafely(error) };
  }
}

/** ./backups/bot-backup-20260310-123456 (UTC), relative to the working directory. */
export function defaultBackupDirectory(at: Date) {
  const stamp = at.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
  return path.join("backups", `bot-backup-${stamp}`);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function formatBackupSummary(directory: string, manifest: BackupManifest) {
  const lines = [
    `Backup written to ${directory}`,
    `  ${plural(manifest.counts.documents, "document", "documents")}, ${plural(manifest.counts.chunks, "chunk", "chunks")}, ${plural(manifest.counts.files, "original file", "original files")}`,
    `  schema version ${manifest.schemaVersion}, created ${manifest.createdAt}`,
  ];
  if (manifest.missingFiles.length > 0) {
    lines.push(`  ${plural(manifest.missingFiles.length, "original file was", "original files were")} already missing from storage and could not be included`);
  }
  lines.push(`Verify it with: npm run backup:verify -- ${directory}`);
  return lines.join("\n");
}

export function formatVerification(result: BackupVerification) {
  const lines: string[] = [];
  if (result.problems.length > 0) {
    lines.push(`PROBLEMS (${result.problems.length})`, ...result.problems.map((problem) => `  - ${problem}`), "");
  }
  if (result.warnings.length > 0) {
    lines.push(`WARNINGS (${result.warnings.length})`, ...result.warnings.map((warning) => `  - ${warning}`), "");
  }
  const checked = `${plural(result.checked.documents, "document", "documents")} and ${plural(result.checked.files, "file", "files")} checked`;
  lines.push(result.ok ? `Backup OK (${checked}).` : `Backup NOT OK (${checked}).`);
  return lines.join("\n");
}
