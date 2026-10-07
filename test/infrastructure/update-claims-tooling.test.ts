import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { createIntegrityTool } from "../../src/composition-root.js";
import { loadToolConfig } from "../../src/config/config.js";
import { createBackup } from "../../src/infrastructure/backup/create-backup.js";
import { inspectLiveInstallation, restoreBackup } from "../../src/infrastructure/backup/restore-backup.js";
import type { RestoreTarget } from "../../src/infrastructure/backup/restore-backup.js";
import { verifyBackup } from "../../src/infrastructure/backup/verify-backup.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { LATEST_SCHEMA_VERSION } from "../../src/infrastructure/sqlite/migrations.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteUpdateClaimStore } from "../../src/infrastructure/sqlite/sqlite-update-claims.js";
import { LocalFileStorage } from "../../src/infrastructure/storage/local-file-storage.js";
import { KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

/** The claim ledger next to the existing tools: backup, restore, integrity and the "empty installation" check all keep working with it. */
const NOW = new Date("2026-03-10T12:00:00.000Z");
const recipe = { embeddingModel: "test-model", chunkSize: 200, chunkOverlap: 20 };

let root: string;
const targetAt = (name: string): RestoreTarget => {
  const dataDir = path.join(root, name);
  return { dataDir, filesDir: path.join(dataDir, "files"), sqlitePath: path.join(dataDir, "app.db") };
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-claims-tools-")); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** An installation with one document and three claims: completed, interrupted and still running. */
async function installation(name: string, options: { withDocument?: boolean } = {}) {
  const target = targetAt(name);
  fs.mkdirSync(target.filesDir, { recursive: true });
  const db = openDatabase(target.sqlitePath, { legacyEmbeddingModel: "test-model" });
  if (options.withDocument ?? true) {
    await new IngestDocumentUseCase({
      documents: new SqliteDocumentRepository(db),
      files: new LocalFileStorage(target.filesDir),
      extractor: new Utf8Extractor(),
      embeddings: new KeywordEmbeddings(),
      options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
    }).execute({ userId: "u1", fileName: "cat.txt", mimeType: "text/plain", data: Buffer.from("The cat sleeps all day on the sofa. ".repeat(10)) });
  }
  const claims = new SqliteUpdateClaimStore(db, { now: () => NOW.getTime() });
  claims.claim(1001, 1); claims.finish(1001, 1, { state: "completed" });
  claims.claim(1001, 2); claims.recoverInterrupted(); // 2 becomes interrupted ...
  claims.claim(1001, 3); // ... and 3 stays running
  return { target, db };
}
const claimRows = (file: string) => {
  const db = new Database(file, { readonly: true });
  try { return db.prepare("SELECT update_id, state, error_category FROM telegram_update_claims ORDER BY update_id").all(); } finally { db.close(); }
};
const EXPECTED = [
  { update_id: 1, state: "completed", error_category: null },
  { update_id: 2, state: "interrupted", error_category: "recovered" },
  { update_id: 3, state: "running", error_category: null },
];

describe("backup and restore", () => {
  it("a backup of an installation with claims verifies cleanly and carries the ledger as it is", async () => {
    const source = await installation("source");
    const backupDir = path.join(root, "backup");
    await createBackup({ db: source.db, filesDir: source.target.filesDir, outputDir: backupDir, now: () => NOW, applicationVersion: "test" });
    source.db.close();

    const verification = await verifyBackup(backupDir, { recipe, now: () => NOW.getTime() });

    expect(verification).toMatchObject({ ok: true, problems: [] });
    expect(verification.manifest?.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
    expect(claimRows(path.join(backupDir, "app.db"))).toEqual(EXPECTED);
  });

  it("a restore brings the ledger back with it; the running claim is only recovered when the bot application starts", async () => {
    const source = await installation("source");
    const backupDir = path.join(root, "backup");
    await createBackup({ db: source.db, filesDir: source.target.filesDir, outputDir: backupDir, now: () => NOW, applicationVersion: "test" });
    source.db.close();
    const target = targetAt("restored");

    const report = await restoreBackup({ backupDir, target, replaceExisting: false, recipe, legacyEmbeddingModel: "test-model", now: () => NOW, newId: () => "id1" });

    expect(report.outcome).toBe("restored");
    expect(claimRows(target.sqlitePath)).toEqual(EXPECTED); // restoring is not bot startup: nothing was recovered
    const db = openDatabase(target.sqlitePath, { legacyEmbeddingModel: "test-model" });
    expect(new SqliteUpdateClaimStore(db).recoverInterrupted()).toBe(1);
    db.close();
  });

  it("a backup made before the ledger existed (schema 10) restores and is migrated in the candidate: an empty ledger appears", async () => {
    const source = await installation("old-source");
    source.db.exec("DROP TABLE telegram_update_claims; PRAGMA user_version = 10");
    const backupDir = path.join(root, "old-backup");
    await createBackup({ db: source.db, filesDir: source.target.filesDir, outputDir: backupDir, now: () => NOW, applicationVersion: "test" });
    source.db.close();
    const target = targetAt("restored-old");

    const report = await restoreBackup({ backupDir, target, replaceExisting: false, recipe, legacyEmbeddingModel: "test-model", now: () => NOW, newId: () => "id1" });

    expect(report.schema).toEqual({ backup: 10, restored: LATEST_SCHEMA_VERSION });
    expect(claimRows(target.sqlitePath)).toEqual([]);
  });

  it("an installation that holds only claims still counts as empty: a restore does not need --replace-existing for it", async () => {
    const source = await installation("claims-only", { withDocument: false });
    source.db.close();

    expect(await inspectLiveInstallation(source.target)).toEqual({ state: "empty" });
  });
});

describe("integrity tool", () => {
  it("reports no issue because of the ledger and leaves it untouched, read-only and with --repair alike", async () => {
    const source = await installation("integrity");
    source.db.pragma("wal_checkpoint(TRUNCATE)");
    source.db.close();
    const config = loadToolConfig({ DATA_DIR: source.target.dataDir, OPENAI_EMBEDDINGS_MODEL: "test-model", CHUNK_SIZE: "200", CHUNK_OVERLAP: "20" });

    for (const writable of [false, true]) {
      const tool = createIntegrityTool(config, { writable, verifyHashes: true });
      try {
        expect((await tool.inspect.execute()).issues).toEqual([]);
        if (tool.repair) expect((await tool.repair.execute({})).after.issues).toEqual([]);
      } finally { tool.close(); }
      expect(claimRows(config.storage.sqlitePath)).toEqual(EXPECTED);
    }
  });
});
