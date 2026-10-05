import path from "node:path";
import { parseArgs } from "node:util";
import type { RestoreError, RestoreReport, RestoreTarget } from "../infrastructure/backup/restore-backup.js";

export const RESTORE_USAGE = `Restores a backup (made by \`npm run backup\`) into the data directory.

Usage: npm run restore -- --from <backup-directory> [options]

  --from <dir>          the backup directory (required; it is never modified)
  --target <dir>        restore into this data directory instead of DATA_DIR (it gets app.db and files/)
  --replace-existing    allow replacing an installation that holds data. Without it a non-empty target is refused.
                        The replaced installation is KEPT in <data dir>/.restore-previous-*, not deleted.
  --discard-previous    with --replace-existing: delete the replaced installation after a successful restore
  --dry-run             verify the backup and prepare + check the candidate, then stop: nothing is changed
  --allow-incomplete    explicitly recover a partial backup with originals recorded as missing
  --help                show this help

What it does, in this order, and stops at the first failure without touching the live installation:
  1. verifies the backup (manifest, format version, SHA-256 of every file, database, integrity checks)
  2. looks at the target: an installation with data needs --replace-existing; a running bot is refused
  3. copies the backup into a staging directory inside the data directory and checks the copies
  4. migrates the staged database if the backup is from an older schema (the live installation is never migrated by a restore)
  5. runs the complete integrity check on the staged candidate
  6. activates it: files are moved in, then the database is renamed over app.db (one atomic step)
Stop the bot before restoring. It needs no API key and no bot token and never calls any provider.`;

export type RestoreCommand =
  | { kind: "run"; from: string; target: string | undefined; replaceExisting: boolean; discardPrevious: boolean; dryRun: boolean; allowIncomplete?: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };

export function parseRestoreArgs(argv: string[]): RestoreCommand {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        from: { type: "string" },
        target: { type: "string" },
        "replace-existing": { type: "boolean" },
        "discard-previous": { type: "boolean" },
        "dry-run": { type: "boolean" },
        "allow-incomplete": { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (values.help) return { kind: "help" };
    if (positionals.length > 0) return { kind: "error", message: `Unexpected argument "${positionals[0]}". The backup directory is given with --from.` };
    if (!values.from) return { kind: "error", message: "Say which backup to restore with --from <backup-directory>." };
    if (values["discard-previous"] && !values["replace-existing"]) {
      return { kind: "error", message: "--discard-previous only makes sense together with --replace-existing." };
    }
    return {
      kind: "run",
      from: values.from,
      target: values.target,
      replaceExisting: values["replace-existing"] ?? false,
      discardPrevious: values["discard-previous"] ?? false,
      dryRun: values["dry-run"] ?? false,
      ...(values["allow-incomplete"] ? { allowIncomplete: true } : {}),
    };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** The data directory layout for `--target`, the same one the application derives from DATA_DIR. */
export function targetFor(dataDir: string): RestoreTarget {
  const resolved = path.resolve(dataDir);
  return { dataDir: resolved, filesDir: path.join(resolved, "files"), sqlitePath: path.join(resolved, "app.db") };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function formatRestoreReport(report: RestoreReport) {
  const counts = `${plural(report.documents, "document", "documents")}, ${plural(report.chunks, "chunk", "chunks")}, ${plural(report.files, "original file", "original files")}`;
  const lines =
    report.outcome === "rehearsed"
      ? [
          `Dry run: the backup can be restored (${counts}). Nothing was changed.`,
          report.requiresReplaceExisting ? "  The target holds data: the real restore needs --replace-existing." : "  The target holds no data: the real restore needs no extra flag.",
        ]
      : [`Restored ${counts}.`];
  lines.push(
    report.schema.backup === report.schema.restored
      ? `  database schema version ${report.schema.restored}`
      : `  database schema migrated from version ${report.schema.backup} to ${report.schema.restored} (in the candidate, before activation)`,
  );
  if (report.previousInstallation) {
    lines.push(`  the replaced installation was kept in ${report.previousInstallation}`);
  }
  if (report.warnings.length > 0) {
    lines.push("", `WARNINGS (${report.warnings.length})`, ...report.warnings.map((warning) => `  - ${warning}`));
  }
  if (report.outcome === "restored") {
    lines.push("", "Start the bot; its startup check reports anything that needs attention. `npm run integrity` checks the restored data in depth.");
  }
  return lines.join("\n");
}

export function formatRestoreError(error: RestoreError) {
  const lines = [`Restore stopped (${error.phase}): ${error.message}`];
  if (error.problems.length > 0) {
    lines.push(`PROBLEMS (${error.problems.length})`, ...error.problems.map((problem) => `  - ${problem}`));
  }
  return lines.join("\n");
}
