import Database from "better-sqlite3";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";
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

/**
 * Opens an existing database strictly read-only, without migrating it: for tools that must not change
 * anything (`npm run integrity`, backup verification). SQLite itself rejects every write on this connection.
 * A database whose schema is not the current one is refused with an explanation, because its tables may
 * lack the columns the checks read.
 */
export function openDatabaseReadOnly(filePath: string, options: { requireCurrentSchema?: boolean } = {}) {
  const db = new Database(filePath, { readonly: true, fileMustExist: true });

  try {
    db.pragma("busy_timeout = 5000");
    const version = db.pragma("user_version", { simple: true }) as number;
    // A backup of a not-yet-migrated database is exactly what one wants before upgrading: its tool opts out.
    if ((options.requireCurrentSchema ?? true) && version !== LATEST_SCHEMA_VERSION) {
      throw new Error(
        `The database has schema version ${version} but this application expects ${LATEST_SCHEMA_VERSION}. ` +
          (version < LATEST_SCHEMA_VERSION
            ? "Start the bot once (or run `npm run reindex -- --dry-run`) to migrate it, then run this command again."
            : "It was written by a newer version of the application."),
      );
    }
  } catch (error) {
    db.close();
    throw error;
  }

  return db;
}
