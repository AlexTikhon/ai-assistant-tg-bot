import "dotenv/config";
import "./quiet-logs.js";
import { loadToolConfig } from "../config/config.js";
import { openDatabaseForMaintenance, openDatabaseReadOnly } from "../infrastructure/sqlite/database.js";
import { runMaintenance } from "../infrastructure/sqlite/maintenance.js";
import { formatMaintenance, isSound, MAINTENANCE_USAGE, parseMaintenanceArgs } from "./db-maintenance-cli.js";
import { printUsage, runCli } from "./run-cli.js";

/** `npm run db:maintenance [-- --checkpoint] [-- --optimize] [-- --vacuum]`. A plain run only checks. */
async function main() {
  const command = parseMaintenanceArgs(process.argv.slice(2));
  if (command.kind !== "run") return printUsage(command, MAINTENANCE_USAGE);

  const config = loadToolConfig();
  const request = { checkpoint: command.checkpoint, optimize: command.optimize, vacuum: command.vacuum, sqlitePath: config.storage.sqlitePath };
  const writes = request.checkpoint || request.optimize || request.vacuum;
  // A plain check opens the database read-only; the actions need a writable connection that does NOT migrate.
  const db = writes ? openDatabaseForMaintenance(config.storage.sqlitePath) : openDatabaseReadOnly(config.storage.sqlitePath, { requireCurrentSchema: false });
  try {
    const report = runMaintenance(db, request);
    console.log(formatMaintenance(report));
    return isSound(report) && !report.refused ? 0 : 1;
  } finally {
    db.close();
  }
}

runCli(main);
