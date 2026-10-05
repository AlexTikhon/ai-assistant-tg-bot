import "dotenv/config";
import "./quiet-logs.js";
import path from "node:path";
import { loadToolConfig } from "../config/config.js";
import { createBackup } from "../infrastructure/backup/create-backup.js";
import { openDatabaseReadOnly } from "../infrastructure/sqlite/database.js";
import { BACKUP_USAGE, defaultBackupDirectory, formatBackupSummary, parseBackupArgs } from "./backup-cli.js";
import { APPLICATION_VERSION } from "../shared/version.js";
import { runCli } from "./run-cli.js";

/**
 * `npm run backup [-- --output <dir>]`. Opens the live database read-only (no migration, no write) and
 * snapshots it through SQLite's backup API, so it is safe while the bot runs. Needs no API key or bot token.
 */
async function main() {
  const command = parseBackupArgs(process.argv.slice(2));

  if (command.kind === "help") {
    console.log(BACKUP_USAGE);
    return 0;
  }
  if (command.kind === "error") {
    console.error(`${command.message}\n\n${BACKUP_USAGE}`);
    return 1;
  }

  const config = loadToolConfig();
  const output = path.resolve(command.output ?? defaultBackupDirectory(new Date()));
  const db = openDatabaseReadOnly(config.storage.sqlitePath, { requireCurrentSchema: false });
  try {
    const manifest = await createBackup({
      db,
      filesDir: config.storage.filesDir,
      outputDir: output,
      now: () => new Date(),
      applicationVersion: APPLICATION_VERSION,
    });
    console.log(formatBackupSummary(output, manifest));
    return 0;
  } finally {
    db.close();
  }
}

runCli(main);
