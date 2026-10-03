import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";
import type { MigrationContext } from "./migrations.js";

/**
 * Opens (and migrates) the application database. Use ":memory:" in tests.
 *
 * WAL + NORMAL synchronous is the usual setup for a single-process app: readers do not block the
 * writer and commits stay durable across application crashes.
 */
export function openDatabase(filePath: string, context: MigrationContext) {
  const db = new Database(filePath);

  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    runMigrations(db, context);
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}
