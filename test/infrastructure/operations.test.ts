import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDiagnostics, parseDiagnosticsArgs } from "../../src/cli/diagnostics-cli.js";
import { formatMaintenance, isSound, parseMaintenanceArgs } from "../../src/cli/db-maintenance-cli.js";
import { createCore } from "../../src/composition-root.js";
import { createOfflineProviders } from "../../src/cli/smoke-providers.js";
import { loadCoreConfig } from "../../src/config/config.js";
import { collectDiagnostics } from "../../src/infrastructure/diagnostics/collect-diagnostics.js";
import {
  applyWritablePragmas,
  classifyDatabaseError,
  openDatabase,
  openDatabaseForMaintenance,
  openDatabaseReadOnly,
  quickCheck,
  readPragmas,
} from "../../src/infrastructure/sqlite/database.js";
import { LATEST_SCHEMA_VERSION } from "../../src/infrastructure/sqlite/migrations.js";
import { runMaintenance } from "../../src/infrastructure/sqlite/maintenance.js";
import { StartupError } from "../../src/shared/errors.js";
import { startBot } from "../../src/startup.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-ops-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const dbPath = () => path.join(root, "data", "app.db");
const env = (extra: Record<string, string> = {}) => ({ DATA_DIR: path.join(root, "data"), OPENAI_EMBEDDINGS_MODEL: "smoke-hashed-v1", CHUNK_SIZE: "300", CHUNK_OVERLAP: "40", ...extra });
const coreAt = () => createCore(loadCoreConfig(env()), createOfflineProviders());

describe("SQLite operational settings are applied to every connection the application opens", () => {
  it("a writable connection: WAL, NORMAL synchronous, foreign keys on, a busy timeout", () => {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    const db = openDatabase(dbPath(), { legacyEmbeddingModel: "m" });

    expect(readPragmas(db)).toEqual({ journalMode: "wal", synchronous: 1, foreignKeys: 1, busyTimeoutMs: 5000 });
    db.close();
  });

  it("the read-only connection (integrity, backup verification, diagnostics) has the busy timeout too and cannot write", () => {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    openDatabase(dbPath(), { legacyEmbeddingModel: "m" }).close();

    const db = openDatabaseReadOnly(dbPath());

    expect(readPragmas(db).busyTimeoutMs).toBe(5000);
    expect(() => db.exec("CREATE TABLE x (y)")).toThrow(/readonly/);
    db.close();
  });

  it("the maintenance connection does not migrate and keeps foreign keys and the busy timeout", () => {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    const old = new Database(dbPath());
    old.pragma("user_version = 3");
    old.close();

    const db = openDatabaseForMaintenance(dbPath());

    expect(db.pragma("user_version", { simple: true })).toBe(3);
    expect(readPragmas(db)).toMatchObject({ foreignKeys: 1, busyTimeoutMs: 5000 });
    db.close();
  });

  it("an in-memory database (tests) gets the same settings, WAL aside", () => {
    const db = new Database(":memory:");
    applyWritablePragmas(db);

    expect(readPragmas(db)).toMatchObject({ synchronous: 1, foreignKeys: 1, busyTimeoutMs: 5000 });
    db.close();
  });

  it("production code opens a database only through these helpers (plus the few documented, deliberate exceptions)", () => {
    const sources = (directory: string): string[] =>
      fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(path.join(directory, entry.name)) : entry.name.endsWith(".ts") ? [path.join(directory, entry.name)] : []));
    const src = path.join(__dirname, "..", "..", "src");
    const allowed = [
      "infrastructure/sqlite/database.ts", // the helpers themselves
      "infrastructure/sqlite/sqlite-integrity-store.ts", // a private in-memory copy for the full-text content check
      "infrastructure/backup/create-backup.ts", // reads the snapshot it just made (a standalone file)
      "infrastructure/backup/restore-backup.ts", // looks at / takes over the LIVE database with its own read-only and exclusive connections
    ];

    const offenders = sources(src)
      .filter((file) => /new Database\(/.test(fs.readFileSync(file, "utf-8")))
      .map((file) => path.relative(src, file).replace(/\\/g, "/"))
      .filter((file) => !allowed.includes(file));

    expect(offenders).toEqual([]);
  });
});

describe("a damaged database stops the start and says what to do - it is never overwritten", () => {
  const garbage = Buffer.from("this is not a database ".repeat(500));

  it("a file that is not a database: StartupError at the database stage, with the recovery path", () => {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    fs.writeFileSync(dbPath(), garbage);

    let error: unknown;
    try {
      coreAt();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).stage).toBe("database");
    expect((error as StartupError).advice).toMatch(/backup:verify.*restore.*--replace-existing/);
    expect(fs.readFileSync(dbPath()).equals(garbage)).toBe(true); // untouched: nothing was overwritten
  });

  it("a database with a damaged page is found by the structural check before anything is served", () => {
    const core = coreAt();
    core.close();
    // Overwrite a data page in the middle of the file (the header stays intact, so SQLite opens it).
    const file = fs.readFileSync(dbPath());
    const pageSize = file.readUInt16BE(16) || 65536;
    expect(file.length).toBeGreaterThan(pageSize * 3);
    const damaged = Buffer.from(file);
    damaged.fill(0xab, pageSize * 2, pageSize * 3);
    fs.writeFileSync(dbPath(), damaged);
    fs.rmSync(`${dbPath()}-wal`, { force: true });
    fs.rmSync(`${dbPath()}-shm`, { force: true });

    let error: unknown;
    try {
      coreAt();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).advice).toMatch(/restore/);
    expect(fs.readFileSync(dbPath()).equals(damaged)).toBe(true);
  });

  it("startBot logs a concise fatal entry with the advice, exits non-zero and never reaches Telegram", async () => {
    const entries: Array<{ level: string; fields: Record<string, unknown> }> = [];
    const log = {
      info: (fields: Record<string, unknown>) => entries.push({ level: "info", fields }),
      warn: (fields: Record<string, unknown>) => entries.push({ level: "warn", fields }),
      fatal: (fields: Record<string, unknown>) => entries.push({ level: "fatal", fields }),
    };
    const runApplication = vi.fn();
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    fs.writeFileSync(dbPath(), garbage);

    const result = await startBot({ readConfig: () => ({}), createApplication: () => (coreAt() as never), runApplication, log });

    expect(result.exitCode).toBe(1);
    expect(runApplication).not.toHaveBeenCalled();
    const fatal = entries.find((entry) => entry.level === "fatal");
    expect(fatal?.fields).toMatchObject({ stage: "database", advice: expect.stringMatching(/restore/) });
  });

  it("classifies SQLite's own error codes", () => {
    expect(classifyDatabaseError({ code: "SQLITE_CORRUPT" }).kind).toBe("corrupt");
    expect(classifyDatabaseError({ code: "SQLITE_CORRUPT_VTAB" }).kind).toBe("corrupt");
    expect(classifyDatabaseError({ code: "SQLITE_NOTADB" }).kind).toBe("not-a-database");
    expect(classifyDatabaseError({ code: "SQLITE_BUSY" })).toMatchObject({ kind: "locked", advice: expect.stringMatching(/another process/) });
    expect(classifyDatabaseError(new Error("something else"))).toEqual({ kind: "other", advice: "" });
    expect(classifyDatabaseError(undefined).kind).toBe("other");
  });

  it("a healthy database passes the structural check", () => {
    const core = coreAt();

    expect(quickCheck(core.db)).toEqual([]);
    core.close();
  });
});

describe("diagnostics", () => {
  const SECRET_KEY = "sk-proj-DoNotLeakThisKey0123456789abcdef";
  const SECRET_TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";

  async function diagnostics() {
    const core = coreAt();
    await core.useCases.ingestDocument.execute({ userId: "telegram-user-424242", fileName: "private-merger-plans.md", mimeType: "text/markdown", data: Buffer.from("# Confidential\n\nThe merger codename is SUPERSECRETCODENAME and closes in June.") });
    core.close();
    const config = loadCoreConfig(env());
    const db = openDatabaseReadOnly(config.storage.sqlitePath, { requireCurrentSchema: false });
    const result = await collectDiagnostics({
      db,
      dataDir: config.storage.dataDir,
      sqlitePath: config.storage.sqlitePath,
      filesDir: config.storage.filesDir,
      application: { version: "1.2.3" },
      recipe: { embeddingModel: "smoke-hashed-v1", chunkSize: 300, chunkOverlap: 40 },
      configuration: { retrievalConfidenceMode: "shadow", chatModel: "gpt-test", embeddingsModel: "smoke-hashed-v1", transcribeModel: "whisper-test", chunkSize: 300, chunkOverlap: 40, maxChunksPerDocument: 2000, maxPdfPages: 1000 },
    });
    db.close();
    return result;
  }

  it("reports versions, schema, counts, storage, index health, confidence mode and model names", async () => {
    const result = await diagnostics();

    expect(result.application).toMatchObject({ version: "1.2.3", node: process.versions.node, platform: process.platform });
    expect(result.sqlite).toMatchObject({ fts5Compiled: true, fullTextIndexPresent: true, schemaVersion: LATEST_SCHEMA_VERSION, expectedSchemaVersion: LATEST_SCHEMA_VERSION });
    expect(result.sqlite.pragmas.foreignKeys).toBe(1);
    expect(result.data).toMatchObject({ users: 1, documents: 1, storedFiles: 1, unreferencedFiles: 0, directoryName: "data", directoryWritable: true });
    expect(result.data.chunks).toBeGreaterThan(0);
    expect(result.index).toEqual({ staleDocuments: 0, corruptIndexDocuments: 0, unindexedDocuments: 0, missingOriginals: 0 });
    expect(result.configuration).toMatchObject({ retrievalConfidenceMode: "shadow", chatModel: "gpt-test", embeddingsModel: "smoke-hashed-v1" });
    expect(result.warnings).toEqual([]);
  });

  it("counts stale and damaged documents", async () => {
    const core = coreAt();
    await core.useCases.ingestDocument.execute({ userId: "u", fileName: "a.md", mimeType: "text/markdown", data: Buffer.from("# A\n\nsome text here about things") });
    core.db.prepare("UPDATE document_chunks SET embedding_dim = 0").run();
    core.close();

    const config = loadCoreConfig(env());
    const db = openDatabaseReadOnly(config.storage.sqlitePath);
    const result = await collectDiagnostics({ db, dataDir: config.storage.dataDir, sqlitePath: config.storage.sqlitePath, filesDir: config.storage.filesDir, application: { version: "1" }, recipe: { embeddingModel: "smoke-hashed-v1", chunkSize: 300, chunkOverlap: 40 }, configuration: {} as never });
    db.close();

    expect(result.index?.corruptIndexDocuments).toBe(1);
  });

  it("never contains secrets, document text, file names, user ids or the full data path - in the text or the JSON form", async () => {
    process.env.OPENAI_API_KEY = SECRET_KEY;
    process.env.TELEGRAM_BOT_TOKEN = SECRET_TOKEN;
    try {
      const result = await diagnostics();
      const outputs = [JSON.stringify(result), formatDiagnostics(result)];

      for (const output of outputs) {
        expect(output).not.toContain(SECRET_KEY);
        expect(output).not.toContain("DoNotLeakThisKey");
        expect(output).not.toContain(SECRET_TOKEN);
        expect(output).not.toContain("SUPERSECRETCODENAME");
        expect(output).not.toContain("private-merger-plans");
        expect(output).not.toContain("telegram-user-424242");
        expect(output).not.toContain(root); // no full paths
        expect(output).not.toContain(os.tmpdir());
      }
    } finally {
      delete process.env.OPENAI_API_KEY;
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("warns when the schema is older and skips what it cannot know", async () => {
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    const old = new Database(dbPath());
    old.exec("CREATE TABLE documents (id TEXT, user_id TEXT, stored_name TEXT); CREATE TABLE document_chunks (id TEXT)");
    old.pragma("user_version = 2");
    old.close();
    const config = loadCoreConfig(env());
    const db = openDatabaseReadOnly(config.storage.sqlitePath, { requireCurrentSchema: false });

    const result = await collectDiagnostics({ db, dataDir: config.storage.dataDir, sqlitePath: config.storage.sqlitePath, filesDir: config.storage.filesDir, application: { version: "1" }, recipe: { embeddingModel: "m", chunkSize: 1, chunkOverlap: 0 }, configuration: {} as never });
    db.close();

    expect(result.index).toBeNull();
    expect(result.warnings.join("\n")).toMatch(/schema is version 2/);
    expect(formatDiagnostics(result)).toContain("not checked");
  });

  it("parses its arguments", () => {
    expect(parseDiagnosticsArgs([])).toEqual({ kind: "run", json: false });
    expect(parseDiagnosticsArgs(["--json"])).toEqual({ kind: "run", json: true });
    expect(parseDiagnosticsArgs(["--help"]).kind).toBe("help");
    expect(parseDiagnosticsArgs(["--nope"]).kind).toBe("error");
  });
});

describe("db:maintenance", () => {
  it("a plain run only checks, and reports a sound database", () => {
    const core = coreAt();
    core.close();
    const db = openDatabaseReadOnly(dbPath());

    const report = runMaintenance(db, { checkpoint: false, optimize: false, vacuum: false, sqlitePath: dbPath() });
    db.close();

    expect(report).toMatchObject({ integrityCheck: ["ok"], foreignKeyViolations: 0, actions: [] });
    expect(isSound(report)).toBe(true);
  });

  it("runs only the actions asked for: checkpoint, optimize and (explicitly) vacuum", () => {
    const core = coreAt();
    core.close();
    const db = openDatabaseForMaintenance(dbPath());

    const checkpoint = runMaintenance(db, { checkpoint: true, optimize: false, vacuum: false, sqlitePath: dbPath() });
    const optimize = runMaintenance(db, { checkpoint: false, optimize: true, vacuum: false, sqlitePath: dbPath() });
    const vacuum = runMaintenance(db, { checkpoint: false, optimize: false, vacuum: true, sqlitePath: dbPath() });
    db.close();

    expect(checkpoint.actions.join()).toMatch(/WAL checkpoint/);
    expect(checkpoint.actions.join()).not.toMatch(/VACUUM|optimize/);
    expect(optimize.actions.join()).toMatch(/optimize/);
    expect(vacuum.actions.join()).toMatch(/VACUUM/);
  });

  it("does nothing to a database that is not sound: it points at restore instead", () => {
    const exec = vi.fn();
    const damaged = {
      pragma: (statement: string) => (statement === "integrity_check" ? [{ integrity_check: "row 7 missing from index idx_chunks_user_model" }] : []),
      exec,
    } as unknown as Database.Database;

    const report = runMaintenance(damaged, { checkpoint: true, optimize: true, vacuum: true, sqlitePath: dbPath() });

    expect(report.actions).toEqual([]);
    expect(report.refused).toMatch(/restore/);
    expect(exec).not.toHaveBeenCalled(); // VACUUM never ran
    expect(isSound(report)).toBe(false);
    expect(formatMaintenance(report)).toMatch(/PROBLEMS[\s\S]*row 7 missing/);
  });

  it("VACUUM is refused when there is not enough free disk space", () => {
    const core = coreAt();
    core.close();
    const db = openDatabaseForMaintenance(dbPath());
    vi.spyOn(fs, "statfsSync").mockReturnValue({ bavail: 1, bsize: 1 } as unknown as fs.StatsFs);

    const report = runMaintenance(db, { checkpoint: false, optimize: false, vacuum: true, sqlitePath: dbPath() });
    db.close();

    expect(report.actions).toEqual([]);
    expect(report.refused).toMatch(/needs about .* MB of free disk space/);
    vi.restoreAllMocks();
  });

  it("parses its arguments; VACUUM is only ever requested explicitly", () => {
    expect(parseMaintenanceArgs([])).toEqual({ kind: "run", checkpoint: false, optimize: false, vacuum: false });
    expect(parseMaintenanceArgs(["--checkpoint", "--optimize"])).toEqual({ kind: "run", checkpoint: true, optimize: true, vacuum: false });
    expect(parseMaintenanceArgs(["--vacuum"])).toMatchObject({ vacuum: true });
    expect(parseMaintenanceArgs(["--bogus"]).kind).toBe("error");
  });
});
