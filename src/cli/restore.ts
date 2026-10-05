import "dotenv/config";
import "./quiet-logs.js";
import path from "node:path";
import { loadToolConfig } from "../config/config.js";
import { RestoreError, restoreBackup } from "../infrastructure/backup/restore-backup.js";
import { formatRestoreError, formatRestoreReport, parseRestoreArgs, RESTORE_USAGE, targetFor } from "./restore-cli.js";
import { runCli } from "./run-cli.js";

/**
 * `npm run restore -- --from <backup> [--target <dir>] [--replace-existing] [--discard-previous] [--dry-run]`.
 * Verifies the backup, prepares and checks a candidate in a staging directory, and only then activates it. Needs no API key
 * or bot token. Exit code 0 on success (or a successful dry run), 1 when the restore did not happen - the live installation is
 * then exactly as it was.
 */
async function main() {
  const command = parseRestoreArgs(process.argv.slice(2));

  if (command.kind === "help") {
    console.log(RESTORE_USAGE);
    return 0;
  }
  if (command.kind === "error") {
    console.error(`${command.message}\n\n${RESTORE_USAGE}`);
    return 1;
  }

  const config = loadToolConfig();
  try {
    const report = await restoreBackup({
      backupDir: path.resolve(command.from),
      target: command.target ? targetFor(command.target) : config.storage,
      replaceExisting: command.replaceExisting,
      discardPrevious: command.discardPrevious,
      dryRun: command.dryRun,
      recipe: { embeddingModel: config.openai.embeddingsModel, ...config.chunking },
      legacyEmbeddingModel: config.openai.embeddingsModel,
      now: () => new Date(),
    });
    console.log(formatRestoreReport(report));
    return 0;
  } catch (error) {
    if (error instanceof RestoreError) {
      console.error(formatRestoreError(error));
      return 1;
    }
    throw error;
  }
}

runCli(main);
