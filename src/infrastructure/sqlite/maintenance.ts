import type Database from "better-sqlite3";
import fs from "node:fs";

export type MaintenanceRequest = {
  /** Fold the write-ahead log into the database file and truncate it (`wal_checkpoint(TRUNCATE)`). */
  checkpoint: boolean;
  /** `PRAGMA optimize`: refreshes the query planner's statistics where SQLite thinks they are stale. Cheap. */
  optimize: boolean;
  /** `VACUUM`: rewrites the database file to give free pages back. Expensive and needs free disk space: only on request. */
  vacuum: boolean;
  /** Where the database file is (for the size and the free-space check). */
  sqlitePath: string;
};

export type MaintenanceReport = {
  /** SQLite's full structural check; ["ok"] when sound. */
  integrityCheck: string[];
  foreignKeyViolations: number;
  /** What was done, in order. Empty for a plain check. */
  actions: string[];
  /** Why the requested actions were not run (the database is not sound, or there is not enough disk space). */
  refused?: string;
  bytesBefore: number;
  bytesAfter: number;
};

const sizeOf = (file: string) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};
const databaseBytes = (file: string) => sizeOf(file) + sizeOf(`${file}-wal`);

/**
 * The small, deliberate maintenance command (`npm run db:maintenance`). It always starts with SQLite's FULL integrity check; the
 * maintenance actions run only when it passes (rewriting or optimizing a damaged file would make it harder to recover), and each
 * action is an explicit request. Nothing here runs at startup, and VACUUM in particular never runs by itself.
 */
export function runMaintenance(db: Database.Database, request: MaintenanceRequest): MaintenanceReport {
  const bytesBefore = databaseBytes(request.sqlitePath);
  const integrityCheck = (db.pragma("integrity_check") as Array<{ integrity_check: string }>).map((row) => row.integrity_check);
  const foreignKeyViolations = (db.pragma("foreign_key_check") as unknown[]).length;
  const report: MaintenanceReport = { integrityCheck, foreignKeyViolations, actions: [], bytesBefore, bytesAfter: bytesBefore };

  const requested = request.checkpoint || request.optimize || request.vacuum;
  if (!requested) return report;

  if (integrityCheck.length !== 1 || integrityCheck[0] !== "ok" || foreignKeyViolations > 0) {
    report.refused = "The database is not sound, so no maintenance was done: verify a backup and restore it (docs/operations.md) rather than rewriting a damaged file.";
    return report;
  }

  if (request.vacuum) {
    // VACUUM builds a complete copy next to the database first (and in WAL mode the log can grow by as much).
    const free = freeBytes(request.sqlitePath);
    const needed = bytesBefore * 2;
    if (free !== null && free < needed) {
      report.refused = `VACUUM needs about ${Math.ceil(needed / 1024 / 1024)} MB of free disk space and ${Math.floor(free / 1024 / 1024)} MB are available; nothing was done.`;
      return report;
    }
  }

  if (request.checkpoint) {
    const [result] = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
    report.actions.push(result?.busy ? "WAL checkpoint: another connection is active, the log could not be truncated" : "WAL checkpoint: the write-ahead log was folded into the database and truncated");
  }
  if (request.optimize) {
    db.pragma("optimize");
    report.actions.push("PRAGMA optimize: query planner statistics refreshed where needed");
  }
  if (request.vacuum) {
    db.exec("VACUUM");
    report.actions.push("VACUUM: the database file was rewritten");
  }

  report.bytesAfter = databaseBytes(request.sqlitePath);
  return report;
}

function freeBytes(file: string): number | null {
  try {
    const stats = fs.statfsSync(file);
    return stats.bavail * stats.bsize;
  } catch {
    return null; // not available on this platform: do not block on it
  }
}
