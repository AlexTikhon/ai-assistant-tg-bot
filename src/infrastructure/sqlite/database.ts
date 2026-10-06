import Database from "better-sqlite3";
import { restrictFile } from "../../shared/fs-permissions.js";
import { LATEST_SCHEMA_VERSION, runMigrations } from "./migrations.js";
import type { MigrationContext } from "./migrations.js";

/**
 * The connection settings every writable connection of this application uses - the bot, `npm run reindex`,
 * `npm run integrity -- --repair`, a restored candidate database and the tests - so the tools behave like the bot:
 *
 * - journal_mode = WAL: readers (a running backup, `npm run integrity`) do not block the bot's writes and the
 *   bot's writes do not block them. It is stored in the database file, so it is set once and then persists.
 * - synchronous = NORMAL: the usual companion of WAL. A commit survives an application crash; only a power loss
 *   or operating-system crash can lose the last few commits (never corrupt the file). FULL would fsync every commit
 *   for a durability gain this single-user-scale application does not need.
 * - foreign_keys = ON: SQLite does not enforce foreign keys unless asked, per connection. The chunk -> document
 *   cascade and the chunk-owner invariant (migration 9) depend on it.
 * - busy_timeout = 5000: a second process (a CLI tool next to the bot) waits up to 5 s for a lock instead of failing at once.
 */
const BUSY_TIMEOUT_MS = 5000;

export function applyWritablePragmas(db: Database.Database) {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

/** What the connection settings really are (diagnostics and tests; `journal_mode` is a property of the file). */
export function readPragmas(db: Database.Database) {
  return {
    journalMode: db.pragma("journal_mode", { simple: true }) as string,
    synchronous: db.pragma("synchronous", { simple: true }) as number,
    foreignKeys: db.pragma("foreign_keys", { simple: true }) as number,
    busyTimeoutMs: db.pragma("busy_timeout", { simple: true }) as number,
  };
}

/**
 * Opens (and migrates) the application database. Use ":memory:" in tests.
 * The file is created readable by its owner only (the database holds users' documents).
 */
export function openDatabase(filePath: string, context: MigrationContext) {
  const db = new Database(filePath);

  try {
    applyWritablePragmas(db);
    runMigrations(db, context);
  } catch (error) {
    db.close();
    throw error;
  }

  if (filePath !== ":memory:") {
    restrictFile(filePath);
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
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
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

/**
 * Opens an existing database writable but WITHOUT migrating it: for maintenance (`npm run db:maintenance`), which
 * must work on whatever schema is there and must never change the schema as a side effect.
 */
export function openDatabaseForMaintenance(filePath: string) {
  const db = new Database(filePath, { fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

export type DatabaseFailure = {
  kind: "corrupt" | "not-a-database" | "locked" | "other";
  /** One sentence for the operator: what it means and which recovery path exists. Never contains data. */
  advice: string;
};

const RECOVERY = "Do not delete it. Verify a backup with `npm run backup:verify -- <directory>` and restore it with `npm run restore -- --from <directory> --replace-existing` (see docs/operations.md).";

/** Recognises a SQLite failure that means "this file is not a usable database" and says what the operator can do. */
export function classifyDatabaseError(error: unknown): DatabaseFailure {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error).code) : "";

  if (code.startsWith("SQLITE_CORRUPT")) {
    return { kind: "corrupt", advice: `The database file is corrupt. ${RECOVERY}` };
  }
  if (code === "SQLITE_NOTADB") {
    return { kind: "not-a-database", advice: `The database file is not a SQLite database (damaged or overwritten). ${RECOVERY}` };
  }
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return { kind: "locked", advice: "The database is locked by another process. Stop the other process (is the bot already running?) and try again." };
  }
  return { kind: "other", advice: "" };
}

/**
 * SQLite's structural check (`PRAGMA quick_check`): reads every page once, so a damaged file is found before the bot
 * accepts any message. Returns the problems it reports (empty when the file is sound).
 */
export function quickCheck(db: Database.Database, limit = 5): string[] {
  const rows = db.pragma(`quick_check(${limit})`) as Array<{ quick_check: string }>;
  return rows.map((row) => row.quick_check).filter((message) => message !== "ok");
}
