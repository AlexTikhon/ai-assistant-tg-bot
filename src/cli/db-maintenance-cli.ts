import { parseArgs } from "node:util";
import type { MaintenanceReport } from "../infrastructure/sqlite/maintenance.js";

export const MAINTENANCE_USAGE = `A small, deliberate SQLite maintenance command. Without options it only checks.

Usage: npm run db:maintenance [-- --checkpoint] [-- --optimize] [-- --vacuum]

  (no option)    SQLite's full integrity check and foreign key check; changes nothing
  --checkpoint   fold the write-ahead log into the database file and truncate it
  --optimize     PRAGMA optimize: refresh query planner statistics where SQLite thinks they are stale (cheap)
  --vacuum       VACUUM: rewrite the file and return free pages. Slow, and needs about twice the database size in free disk space.
                 Never runs on its own - not at startup, not with the other options.

Actions run only when the integrity check passes. Stop the bot first for --vacuum (it needs exclusive access).
Exit code 1 when the database is not sound.`;

export type MaintenanceCommand = { kind: "run"; checkpoint: boolean; optimize: boolean; vacuum: boolean } | { kind: "help" } | { kind: "error"; message: string };

export function parseMaintenanceArgs(argv: string[]): MaintenanceCommand {
  try {
    const { values } = parseArgs({ args: argv, options: { checkpoint: { type: "boolean" }, optimize: { type: "boolean" }, vacuum: { type: "boolean" }, help: { type: "boolean" } }, strict: true, allowPositionals: false });
    if (values.help) return { kind: "help" };
    return { kind: "run", checkpoint: values.checkpoint ?? false, optimize: values.optimize ?? false, vacuum: values.vacuum ?? false };
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export const isSound = (report: MaintenanceReport) => report.integrityCheck.length === 1 && report.integrityCheck[0] === "ok" && report.foreignKeyViolations === 0;

export function formatMaintenance(report: MaintenanceReport) {
  const lines = [isSound(report) ? "Integrity check: ok" : `Integrity check: PROBLEMS\n${report.integrityCheck.filter((row) => row !== "ok").map((row) => `  - ${row}`).join("\n")}`];
  if (report.foreignKeyViolations > 0) lines.push(`Foreign key check: ${report.foreignKeyViolations} violations`);
  for (const action of report.actions) lines.push(action);
  if (report.refused) lines.push(`NOT DONE: ${report.refused}`);
  if (report.actions.length > 0) lines.push(`Database size: ${Math.round(report.bytesBefore / 1024)} KB -> ${Math.round(report.bytesAfter / 1024)} KB (including the write-ahead log)`);
  return lines.join("\n");
}
