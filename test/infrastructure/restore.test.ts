import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { InspectIntegrityUseCase } from "../../src/application/use-cases/inspect-integrity.use-case.js";
import { RepairIntegrityUseCase } from "../../src/application/use-cases/repair-integrity.use-case.js";
import { createBackup } from "../../src/infrastructure/backup/create-backup.js";
import { BACKUP_FORMAT_VERSION, MANIFEST_FILE } from "../../src/infrastructure/backup/manifest.js";
import type { BackupManifest } from "../../src/infrastructure/backup/manifest.js";
import { DataDirectoryRestoreArtifacts } from "../../src/infrastructure/backup/restore-artifacts.js";
import { inspectLiveInstallation, RestoreError, restoreBackup } from "../../src/infrastructure/backup/restore-backup.js";
import type { RestoreStep, RestoreTarget } from "../../src/infrastructure/backup/restore-backup.js";
import { openDatabase, openDatabaseReadOnly } from "../../src/infrastructure/sqlite/database.js";
import { LATEST_SCHEMA_VERSION, migrations } from "../../src/infrastructure/sqlite/migrations.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteIndexMaintenance } from "../../src/infrastructure/sqlite/sqlite-index-maintenance.js";
import { SqliteIntegrityStore } from "../../src/infrastructure/sqlite/sqlite-integrity-store.js";
import { SqliteVectorStore } from "../../src/infrastructure/sqlite/sqlite-vector-store.js";
import { LocalFileStorage } from "../../src/infrastructure/storage/local-file-storage.js";
import { KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

const NOW = new Date("2026-03-10T12:00:00.000Z");
const recipe = { embeddingModel: "test-model", chunkSize: 200, chunkOverlap: 20 };
const CAT = "The cat sleeps all day on the sofa. ".repeat(10);
const TAX = "Quarterly tax forms are due in April. ".repeat(10);

let root: string;
let counter = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-restore-"));
  counter = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const targetAt = (name: string): RestoreTarget => {
  const dataDir = path.join(root, name);
  return { dataDir, filesDir: path.join(dataDir, "files"), sqlitePath: path.join(dataDir, "app.db") };
};

/** A real installation (database file + files directory) with documents ingested through the real use case. */
async function installation(name: string, documents: Array<[fileName: string, text: string]>, userId = "u1") {
  const target = targetAt(name);
  fs.mkdirSync(target.filesDir, { recursive: true });
  const db = openDatabase(target.sqlitePath, { legacyEmbeddingModel: "test-model" });
  const ingest = new IngestDocumentUseCase({
    documents: new SqliteDocumentRepository(db),
    files: new LocalFileStorage(target.filesDir),
    extractor: new Utf8Extractor(),
    embeddings: new KeywordEmbeddings(),
    options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
  });
  for (const [fileName, text] of documents) {
    await ingest.execute({ userId, fileName, mimeType: "text/plain", data: Buffer.from(text) });
  }
  return { target, db, close: () => db.close() };
}

async function makeBackup(name: string, documents: Array<[string, string]> = [["cat.txt", CAT], ["tax.txt", TAX]]) {
  const source = await installation(`source-${name}`, documents);
  const outputDir = path.join(root, `backup-${name}`);
  const manifest = await createBackup({ db: source.db, filesDir: source.target.filesDir, outputDir, now: () => NOW, applicationVersion: "9.9.9" });
  source.close();
  return { dir: outputDir, manifest };
}

const restore = (backupDir: string, target: RestoreTarget, extra: Partial<Parameters<typeof restoreBackup>[0]> = {}) =>
  restoreBackup({
    backupDir,
    target,
    replaceExisting: false,
    recipe,
    legacyEmbeddingModel: "test-model",
    now: () => NOW,
    newId: () => `id${(counter += 1)}`,
    ...extra,
  });

const failure = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RestoreError);
  return error as RestoreError;
};

/** Every file below a directory with its content hash: two equal fingerprints mean nothing changed. */
function fingerprint(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else result[path.relative(directory, full).replace(/\\/g, "/")] = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return result;
}

const leftovers = (dataDir: string) => (fs.existsSync(dataDir) ? fs.readdirSync(dataDir).filter((name) => name.startsWith(".restore-")) : []);
const rewriteManifest = (dir: string, change: (manifest: BackupManifest) => unknown) => {
  const file = path.join(dir, MANIFEST_FILE);
  fs.writeFileSync(file, JSON.stringify(change(JSON.parse(fs.readFileSync(file, "utf-8")))));
};

describe("restore: a valid backup", () => {
  it("restores into an empty target: database, files and counts", async () => {
    const backup = await makeBackup("a");
    const target = targetAt("live");

    const report = await restore(backup.dir, target);

    expect(report).toMatchObject({ outcome: "restored", live: "absent", requiresReplaceExisting: false, previousInstallation: null, documents: 2, files: 2 });
    expect(report.schema).toEqual({ backup: LATEST_SCHEMA_VERSION, restored: LATEST_SCHEMA_VERSION });
    const db = openDatabaseReadOnly(target.sqlitePath);
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 2 });
    db.close();
    for (const file of backup.manifest.files) {
      expect(fs.readFileSync(path.join(target.filesDir, file.storedName)).equals(fs.readFileSync(path.join(backup.dir, "files", file.storedName)))).toBe(true);
    }
    expect(leftovers(target.dataDir)).toEqual([]); // the staging area is gone
  });

  it("never modifies the backup it restores from", async () => {
    const backup = await makeBackup("a");
    const before = fingerprint(backup.dir);

    await restore(backup.dir, targetAt("live"));

    expect(fingerprint(backup.dir)).toEqual(before);
  });

  it("restores into an installation that exists but holds nothing (a database that was only ever started), without any flag", async () => {
    const backup = await makeBackup("a");
    const live = await installation("live", []);
    live.close();

    const report = await restore(backup.dir, live.target);

    expect(report).toMatchObject({ outcome: "restored", live: "empty", documents: 2 });
  });

  it("the restored database passes the complete integrity check, including the deep full-text check", async () => {
    const backup = await makeBackup("a");
    const target = targetAt("live");
    await restore(backup.dir, target);

    const db = openDatabaseReadOnly(target.sqlitePath);
    const report = await new InspectIntegrityUseCase({
      store: new SqliteIntegrityStore(db),
      maintenance: new SqliteIndexMaintenance(db),
      files: new LocalFileStorage(target.filesDir),
      recipe,
      now: () => NOW.getTime(),
      verifyHashes: true,
      deepFullText: true,
    }).execute();
    db.close();

    expect(report.issues).toEqual([]);
    expect(report.summary).toMatchObject({ documents: 2, errors: 0 });
  });

  it("the restored full-text index finds the restored text", async () => {
    const backup = await makeBackup("a");
    const target = targetAt("live");
    await restore(backup.dir, target);

    const db = openDatabase(target.sqlitePath, { legacyEmbeddingModel: "test-model" });
    const store = new SqliteVectorStore(db);
    const hits = await store.searchLexical({ userId: "u1", query: "tax forms April", limit: 5 });
    db.close();

    expect(hits.length).toBeGreaterThan(0);
  });

  it("vector search works on the restored data using the stored embeddings: no provider is involved, the query vector comes from a local function", async () => {
    const backup = await makeBackup("a");
    const target = targetAt("live");
    await restore(backup.dir, target);

    const db = openDatabase(target.sqlitePath, { legacyEmbeddingModel: "test-model" });
    const store = new SqliteVectorStore(db);
    const embeddings = new KeywordEmbeddings();
    const hits = await store.searchSimilar({ userId: "u1", embedding: await embeddings.embedQuery("tell me about the cat"), embeddingModel: "test-model", limit: 3, minScore: 0.2 });
    const texts = await store.getChunks("u1", hits.map((hit) => hit.chunkId));
    db.close();

    expect(hits.length).toBeGreaterThan(0);
    expect(texts[0].fileName).toBe("cat.txt");
    expect(embeddings.documentCalls).toEqual([]); // nothing was re-embedded
  });

  it("restores another user's documents too and keeps every document with its owner", async () => {
    const source = await installation("source-multi", [["a.txt", CAT]], "alice");
    const bobIngest = new IngestDocumentUseCase({
      documents: new SqliteDocumentRepository(source.db),
      files: new LocalFileStorage(source.target.filesDir),
      extractor: new Utf8Extractor(),
      embeddings: new KeywordEmbeddings(),
      options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
    });
    await bobIngest.execute({ userId: "bob", fileName: "b.txt", mimeType: "text/plain", data: Buffer.from(TAX) });
    const outputDir = path.join(root, "backup-multi");
    await createBackup({ db: source.db, filesDir: source.target.filesDir, outputDir, now: () => NOW, applicationVersion: "1" });
    source.close();
    const target = targetAt("live");

    await restore(outputDir, target);

    const db = openDatabaseReadOnly(target.sqlitePath);
    expect(db.prepare("SELECT user_id AS u, file_name AS f FROM documents ORDER BY user_id").all()).toEqual([
      { u: "alice", f: "a.txt" },
      { u: "bob", f: "b.txt" },
    ]);
    db.close();
  });
});

describe("restore: a backup that is not sound is refused, and nothing is created", () => {
  const expectUntouched = (target: RestoreTarget) => expect(fs.existsSync(target.dataDir)).toBe(false);

  it("invalid manifest", async () => {
    const backup = await makeBackup("a");
    fs.writeFileSync(path.join(backup.dir, MANIFEST_FILE), "{ this is not json");
    const target = targetAt("live");

    const error = await failure(restore(backup.dir, target));

    expect(error.phase).toBe("verify");
    expect(error.problems.join("\n")).toMatch(/manifest/i);
    expectUntouched(target);
  });

  it("missing manifest (an unfinished backup)", async () => {
    const backup = await makeBackup("a");
    fs.rmSync(path.join(backup.dir, MANIFEST_FILE));
    const target = targetAt("live");

    expect((await failure(restore(backup.dir, target))).problems.join("\n")).toMatch(/not a finished backup/);
    expectUntouched(target);
  });

  it("missing database file", async () => {
    const backup = await makeBackup("a");
    fs.rmSync(path.join(backup.dir, "app.db"));
    const target = targetAt("live");

    expect((await failure(restore(backup.dir, target))).problems.join("\n")).toMatch(/database file app\.db is missing/);
    expectUntouched(target);
  });

  it("missing stored file", async () => {
    const backup = await makeBackup("a");
    fs.rmSync(path.join(backup.dir, "files", backup.manifest.files[0].storedName));
    const target = targetAt("live");

    expect((await failure(restore(backup.dir, target))).problems.join("\n")).toContain(`missing from the backup: ${backup.manifest.files[0].storedName}`);
    expectUntouched(target);
  });

  it("content hash mismatch of a stored file", async () => {
    const backup = await makeBackup("a");
    const file = path.join(backup.dir, "files", backup.manifest.files[0].storedName);
    fs.writeFileSync(file, Buffer.from("Z".repeat(backup.manifest.files[0].bytes)));
    const target = targetAt("live");

    expect((await failure(restore(backup.dir, target))).problems.join("\n")).toMatch(/hash mismatch/i);
    expectUntouched(target);
  });

  it("database that does not match the manifest", async () => {
    const backup = await makeBackup("a");
    fs.appendFileSync(path.join(backup.dir, "app.db"), "tail");
    const target = targetAt("live");

    expect((await failure(restore(backup.dir, target))).problems.join("\n")).toMatch(/does not match the manifest/);
    expectUntouched(target);
  });

  it("unsupported (newer) backup format version", async () => {
    const backup = await makeBackup("a");
    rewriteManifest(backup.dir, (manifest) => ({ ...manifest, formatVersion: BACKUP_FORMAT_VERSION + 1 }));
    const target = targetAt("live");

    const error = await failure(restore(backup.dir, target));

    expect(error.problems.join("\n")).toMatch(/newer than this application understands/);
    expectUntouched(target);
  });

  it("a backup of some other application", async () => {
    const backup = await makeBackup("a");
    rewriteManifest(backup.dir, (manifest) => ({ ...manifest, application: { name: "something-else", version: "1" } }));

    expect((await failure(restore(backup.dir, targetAt("live")))).problems.join("\n")).toMatch(/not of telegram-rag-bot/);
  });

  it("a database schema newer than this application supports", async () => {
    const backup = await makeBackup("a");
    const db = new Database(path.join(backup.dir, "app.db"));
    db.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    db.close();
    rewriteManifest(backup.dir, (manifest) => ({
      ...manifest,
      schemaVersion: LATEST_SCHEMA_VERSION + 1,
      database: { ...manifest.database, sha256: createHash("sha256").update(fs.readFileSync(path.join(backup.dir, "app.db"))).digest("hex"), bytes: fs.statSync(path.join(backup.dir, "app.db")).size },
    }));
    const target = targetAt("live");

    expect((await failure(restore(backup.dir, target))).problems.join("\n")).toMatch(/newer than this application supports/);
    expectUntouched(target);
  });

  it("a backup whose database fails the integrity check (here: a chunk missing from the middle of a document)", async () => {
    const source = await installation("source-broken", [["cat.txt", CAT]]);
    source.db.prepare("DELETE FROM document_chunks WHERE chunk_index = 0").run();
    const outputDir = path.join(root, "backup-broken");
    await createBackup({ db: source.db, filesDir: source.target.filesDir, outputDir, now: () => NOW, applicationVersion: "1" });
    source.close();
    const target = targetAt("live");

    const error = await failure(restore(outputDir, target));

    expect(error.problems.join("\n")).toMatch(/chunk-index-gap/);
    expectUntouched(target);
  });

  it("refuses when the backup directory is the data directory itself", async () => {
    const backup = await makeBackup("a");

    expect((await failure(restore(backup.dir, { dataDir: backup.dir, filesDir: path.join(backup.dir, "files"), sqlitePath: path.join(backup.dir, "app.db") }))).phase).toBe("refused");
  });
});

describe("restore: an installation that holds data is replaced only on request, and is kept", () => {
  it("refuses a populated target without --replace-existing and changes nothing", async () => {
    const backup = await makeBackup("a");
    const live = await installation("live", [["mine.txt", "My only copy of this document. ".repeat(10)]]);
    live.close();
    const before = fingerprint(live.target.dataDir);

    const error = await failure(restore(backup.dir, live.target));

    expect(error.phase).toBe("refused");
    expect(error.message).toMatch(/--replace-existing/);
    expect(fingerprint(live.target.dataDir)).toEqual(before);
  });

  it("with --replace-existing: the backup becomes live, and the replaced installation is kept in full", async () => {
    const backup = await makeBackup("a");
    const live = await installation("live", [["mine.txt", "My only copy of this document. ".repeat(10)]]);
    const mineStored = (live.db.prepare("SELECT stored_name AS name FROM documents").get() as { name: string }).name;
    live.close();

    const report = await restore(backup.dir, live.target, { replaceExisting: true });

    expect(report).toMatchObject({ outcome: "restored", live: "populated", requiresReplaceExisting: true, previousInstallation: expect.stringMatching(/^\.restore-previous-20260310-120000-id1$/) });
    // Live now equals the backup.
    const liveDb = openDatabaseReadOnly(live.target.sqlitePath);
    expect(liveDb.prepare("SELECT file_name AS f FROM documents ORDER BY file_name").all()).toEqual([{ f: "cat.txt" }, { f: "tax.txt" }]);
    liveDb.close();
    expect(fs.readdirSync(live.target.filesDir).sort()).toEqual(backup.manifest.files.map((file) => file.storedName).sort());
    // The previous installation is complete and readable.
    const previous = path.join(live.target.dataDir, report.previousInstallation!);
    const previousDb = openDatabaseReadOnly(path.join(previous, "app.db"));
    expect(previousDb.prepare("SELECT file_name AS f FROM documents").all()).toEqual([{ f: "mine.txt" }]);
    previousDb.close();
    expect(fs.readFileSync(path.join(previous, "files", mineStored), "utf-8")).toContain("My only copy");
    expect(report.warnings.join("\n")).toMatch(/was kept in \.restore-previous-/);
  });

  it("with --discard-previous the replaced installation is removed after the restore succeeded", async () => {
    const backup = await makeBackup("a");
    const live = await installation("live", [["mine.txt", "My only copy of this document. ".repeat(10)]]);
    live.close();

    const report = await restore(backup.dir, live.target, { replaceExisting: true, discardPrevious: true });

    expect(report.previousInstallation).toBeNull();
    expect(leftovers(live.target.dataDir)).toEqual([]);
    expect(fs.readdirSync(live.target.filesDir).sort()).toEqual(backup.manifest.files.map((file) => file.storedName).sort());
  });

  it("restoring a backup over the installation it was made from: identical files are recognised, nothing is duplicated, the data is the backup's", async () => {
    const live = await installation("live", [["cat.txt", CAT]]);
    const outputDir = path.join(root, "backup-live");
    const manifest = await createBackup({ db: live.db, filesDir: live.target.filesDir, outputDir, now: () => NOW, applicationVersion: "1" });
    await new IngestDocumentUseCase({
      documents: new SqliteDocumentRepository(live.db),
      files: new LocalFileStorage(live.target.filesDir),
      extractor: new Utf8Extractor(),
      embeddings: new KeywordEmbeddings(),
      options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
    }).execute({ userId: "u1", fileName: "later.txt", mimeType: "text/plain", data: Buffer.from(TAX) });
    live.close();

    const report = await restore(outputDir, live.target, { replaceExisting: true });

    expect(report.documents).toBe(1);
    expect(fs.readdirSync(live.target.filesDir)).toEqual(manifest.files.map((file) => file.storedName)); // the later upload's file moved aside
    const previous = path.join(live.target.dataDir, report.previousInstallation!, "files");
    expect(fs.readdirSync(previous)).toHaveLength(1);
  });

  it("a running bot is refused: the live database is locked by another connection", async () => {
    const backup = await makeBackup("a");
    const live = await installation("live", [["mine.txt", "My only copy of this document. ".repeat(10)]]);
    const before = fingerprint(live.target.filesDir);

    const error = await failure(restore(backup.dir, live.target, { replaceExisting: true }));
    live.close();

    expect(error.message).toMatch(/in use by another process/);
    expect(fingerprint(live.target.filesDir)).toEqual(before);
    expect(leftovers(live.target.dataDir)).toEqual([]);
  });

  it("a bot running as a SEPARATE PROCESS is refused too (the case that matters in production: locks held by another process)", async () => {
    const backup = await makeBackup("a");
    const live = await installation("live", [["mine.txt", "My only copy of this document. ".repeat(10)]]);
    live.close();
    const before = fingerprint(live.target.dataDir);
    // A real second process with the database open, as the bot has it (WAL, idle between updates).
    const holder = spawn(
      process.execPath,
      ["-e", "const Database = require('better-sqlite3'); const db = new Database(process.argv[1]); db.pragma('journal_mode = WAL'); db.prepare('SELECT COUNT(*) FROM documents').get(); console.log('open'); process.stdin.resume();", live.target.sqlitePath],
      { stdio: ["pipe", "pipe", "inherit"], cwd: path.join(__dirname, "..", "..") },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        holder.stdout.once("data", () => resolve());
        holder.once("error", reject);
        holder.once("exit", (code) => reject(new Error(`the holder process exited early (${code})`)));
      });
      const stateWhileRunning = fingerprint(live.target.filesDir);

      const error = await failure(restore(backup.dir, live.target, { replaceExisting: true }));

      expect(error.message).toMatch(/in use by another process/);
      expect(fingerprint(live.target.filesDir)).toEqual(stateWhileRunning);
      expect(leftovers(live.target.dataDir)).toEqual([]);
    } finally {
      holder.kill();
      await new Promise((resolve) => holder.once("exit", resolve));
    }
    expect(Object.keys(fingerprint(live.target.dataDir)).filter((name) => name.startsWith("files/"))).toEqual(Object.keys(before).filter((name) => name.startsWith("files/")));
  });

  it("a damaged live database (not a database at all) can be replaced with the flag, and the damaged file is kept as evidence", async () => {
    const backup = await makeBackup("a");
    const target = targetAt("live");
    fs.mkdirSync(target.filesDir, { recursive: true });
    fs.writeFileSync(target.sqlitePath, Buffer.from("this is definitely not a sqlite database ".repeat(200)));
    fs.writeFileSync(`${target.sqlitePath}-wal`, "stale wal that must never meet the restored database");

    expect((await inspectLiveInstallation(target)).state).toBe("unreadable");
    expect((await failure(restore(backup.dir, target))).phase).toBe("refused");

    const report = await restore(backup.dir, target, { replaceExisting: true });

    expect(report).toMatchObject({ outcome: "restored", live: "unreadable" });
    expect(fs.existsSync(`${target.sqlitePath}-wal`)).toBe(false); // the stale write-ahead log is gone from the live location
    const db = openDatabase(target.sqlitePath, { legacyEmbeddingModel: "test-model" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 2 });
    expect(db.pragma("quick_check", { simple: true })).toBe("ok");
    db.close();
    const previous = path.join(target.dataDir, report.previousInstallation!);
    expect(fs.readFileSync(path.join(previous, "app.db"), "utf-8")).toContain("definitely not a sqlite database");
    expect(fs.readFileSync(path.join(previous, "app.db-wal"), "utf-8")).toContain("stale wal");
  });

  it("a target that has stored files but no database counts as holding data", async () => {
    const backup = await makeBackup("a");
    const target = targetAt("live");
    fs.mkdirSync(target.filesDir, { recursive: true });
    fs.writeFileSync(path.join(target.filesDir, "survivor.pdf"), "the only copy");

    expect((await inspectLiveInstallation(target)).state).toBe("populated");
    expect((await failure(restore(backup.dir, target))).phase).toBe("refused");
  });
});

describe("restore: failure injection - a failed restore leaves the live installation exactly as it was", () => {
  const steps: RestoreStep[] = ["verified", "staged", "candidate-ready", "files-published", "before-commit"];

  it.each(steps)("a failure at %s changes nothing: same database, same files, no staging, no extra files", async (step) => {
    const backup = await makeBackup("a");
    const live = await installation("live", [["mine.txt", "My only copy of this document. ".repeat(10)]]);
    live.close();
    const before = fingerprint(live.target.dataDir);

    const error = await failure(
      restore(backup.dir, live.target, {
        replaceExisting: true,
        hooks: {
          at: (reached) => {
            if (reached === step) throw new Error(`injected failure at ${step}`);
          },
        },
      }),
    );

    expect(error.message).toMatch(new RegExp(`injected failure at ${step}`));
    expect(fingerprint(live.target.dataDir)).toEqual(before); // every file of the data directory, byte for byte
    expect(leftovers(live.target.dataDir)).toEqual([]);
  });

  it("a failure at the last moment before the commit has even moved the new files in - and they are removed again", async () => {
    const backup = await makeBackup("a");
    const live = await installation("live", [["mine.txt", "My only copy of this document. ".repeat(10)]]);
    live.close();
    let filesAtThatPoint: string[] = [];

    await failure(
      restore(backup.dir, live.target, {
        replaceExisting: true,
        hooks: {
          at: (step) => {
            if (step === "before-commit") {
              filesAtThatPoint = fs.readdirSync(live.target.filesDir);
              throw new Error("boom");
            }
          },
        },
      }),
    );

    expect(filesAtThatPoint).toHaveLength(3); // the live file plus the two staged ones were really there...
    expect(fs.readdirSync(live.target.filesDir)).toHaveLength(1); // ...and the rollback removed exactly the two it added
  });

  it("the live database is not migrated or otherwise touched by a failed restore (an older live schema stays older)", async () => {
    const backup = await makeBackup("a");
    const target = targetAt("live");
    fs.mkdirSync(target.filesDir, { recursive: true });
    const old = new Database(target.sqlitePath);
    for (const migration of migrations.filter((candidate) => candidate.version <= 8)) {
      old.transaction(() => {
        migration.up(old, { legacyEmbeddingModel: "m" });
        old.pragma(`user_version = ${migration.version}`);
      })();
    }
    old.prepare("INSERT INTO documents (id, user_id, file_name, stored_name, file_size, text_length, created_at) VALUES ('keep', 'u1', 'keep.txt', 'k', 1, 1, '2026-01-01')").run();
    old.close();

    await failure(restore(backup.dir, target, { replaceExisting: true, hooks: { at: (step) => { if (step === "before-commit") throw new Error("boom"); } } }));

    const after = new Database(target.sqlitePath, { readonly: true });
    expect(after.pragma("user_version", { simple: true })).toBe(8);
    expect(after.prepare("SELECT id FROM documents").all()).toEqual([{ id: "keep" }]);
    after.close();
  });

  it("a failed restore into an empty target leaves nothing behind either", async () => {
    const backup = await makeBackup("a");
    const target = targetAt("live");

    await failure(restore(backup.dir, target, { hooks: { at: (step) => { if (step === "candidate-ready") throw new Error("boom"); } } }));

    expect(fs.existsSync(target.sqlitePath)).toBe(false);
    expect(fs.existsSync(target.filesDir) ? fs.readdirSync(target.filesDir) : []).toEqual([]);
    expect(leftovers(target.dataDir)).toEqual([]);
  });

  it("a staged copy that does not match the manifest (corrupted while copying) is never used", async () => {
    const backup = await makeBackup("a");
    const target = targetAt("live");
    // The backup verifies, then a file changes before it is copied: the check after the copy catches it.
    const error = await failure(
      restore(backup.dir, target, {
        hooks: {
          at: (step) => {
            if (step === "verified") fs.appendFileSync(path.join(backup.dir, "files", backup.manifest.files[0].storedName), "x");
          },
        },
      }),
    );

    expect(error.message).toMatch(/did not match the manifest after it was copied/);
    expect(fs.existsSync(target.sqlitePath)).toBe(false);
  });
});

describe("restore: a backup from an older schema is migrated in the candidate", () => {
  /** A backup as the previous release (schema version 8) made it: the database was never migrated. */
  async function makeVersion8Backup() {
    const source = targetAt("source-v8");
    fs.mkdirSync(source.filesDir, { recursive: true });
    const db = new Database(source.sqlitePath);
    db.pragma("journal_mode = WAL");
    for (const migration of migrations.filter((candidate) => candidate.version <= 8)) {
      db.transaction(() => {
        migration.up(db, { legacyEmbeddingModel: "test-model" });
        db.pragma(`user_version = ${migration.version}`);
      })();
    }
    const stored = "11111111-1111-1111-1111-111111111111.txt";
    fs.writeFileSync(path.join(source.filesDir, stored), CAT);
    db.prepare("INSERT INTO documents (id, user_id, file_name, stored_name, mime_type, file_size, text_length, created_at, content_hash) VALUES ('d1', 'u1', 'cat.txt', ?, 'text/plain', ?, ?, '2026-01-01', ?)").run(
      stored,
      CAT.length,
      CAT.length,
      createHash("sha256").update(CAT).digest("hex"),
    );
    db.prepare("INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at) VALUES ('c0', 'd1', 'u1', 0, ?, x'0000803f000000000000000000000000', 'test-model', 4, '2026-01-01')").run(CAT);
    const outputDir = path.join(root, "backup-v8");
    const manifest = await createBackup({ db, filesDir: source.filesDir, outputDir, now: () => NOW, applicationVersion: "0.9.0" });
    db.close();
    return { dir: outputDir, manifest };
  }

  it("restores it: the candidate is migrated to the current schema before it is activated, the backup itself stays as it was", async () => {
    const backup = await makeVersion8Backup();
    expect(backup.manifest.schemaVersion).toBe(8);
    const before = fingerprint(backup.dir);
    const target = targetAt("live");

    const report = await restore(backup.dir, target);

    expect(report.schema).toEqual({ backup: 8, restored: LATEST_SCHEMA_VERSION });
    expect(report.warnings.join("\n")).toMatch(/migrated to schema 9/);
    const db = openDatabaseReadOnly(target.sqlitePath);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'cat'").get()).toEqual({ n: 1 });
    expect(() => db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_documents_id_user'").get()).not.toThrow();
    db.close();
    expect(fingerprint(backup.dir)).toEqual(before);
  });

  it("an older backup whose data cannot satisfy the new constraints fails in the candidate, and the live installation is untouched", async () => {
    const backup = await makeVersion8Backup();
    const copy = new Database(path.join(backup.dir, "app.db"));
    copy.pragma("journal_mode = DELETE");
    copy.prepare("UPDATE document_chunks SET user_id = 'intruder'").run();
    copy.close();
    rewriteManifest(backup.dir, (manifest) => ({
      ...manifest,
      database: { ...manifest.database, sha256: createHash("sha256").update(fs.readFileSync(path.join(backup.dir, "app.db"))).digest("hex"), bytes: fs.statSync(path.join(backup.dir, "app.db")).size },
    }));
    const live = await installation("live", [["mine.txt", "My only copy of this document. ".repeat(10)]]);
    live.close();
    const before = fingerprint(live.target.dataDir);

    const error = await failure(restore(backup.dir, live.target, { replaceExisting: true }));

    expect(error.phase).toBe("prepare");
    expect(error.message).toMatch(/Migration 9 cannot run/);
    expect(fingerprint(live.target.dataDir)).toEqual(before);
  });
});

describe("restore: dry run", () => {
  it("prepares and checks everything, reports what it would do, and changes nothing", async () => {
    const backup = await makeBackup("a");
    const live = await installation("live", [["mine.txt", "My only copy of this document. ".repeat(10)]]);
    live.close();
    const before = fingerprint(live.target.dataDir);

    const report = await restore(backup.dir, live.target, { dryRun: true });

    expect(report).toMatchObject({ outcome: "rehearsed", documents: 2, requiresReplaceExisting: true, previousInstallation: null });
    expect(fingerprint(live.target.dataDir)).toEqual(before);
    expect(leftovers(live.target.dataDir)).toEqual([]);
  });

  it("still refuses a backup that is not sound", async () => {
    const backup = await makeBackup("a");
    fs.rmSync(path.join(backup.dir, "app.db"));

    expect((await failure(restore(backup.dir, targetAt("live"), { dryRun: true }))).phase).toBe("verify");
  });
});

describe("restore leftovers are discoverable and cleanable by the integrity command", () => {
  const HOUR = 3600_000;

  async function inspectAndRepair(dataDir: string, nowMs: number) {
    const live = await installation("probe", []);
    const artifacts = new DataDirectoryRestoreArtifacts(dataDir);
    const store = new SqliteIntegrityStore(live.db);
    const inspect = new InspectIntegrityUseCase({ store, maintenance: new SqliteIndexMaintenance(live.db), files: new LocalFileStorage(live.target.filesDir), recipe, now: () => nowMs, verifyHashes: false, restoreArtifacts: artifacts });
    const repair = new RepairIntegrityUseCase({ inspect, store, documents: new SqliteDocumentRepository(live.db), files: new LocalFileStorage(live.target.filesDir), restoreArtifacts: artifacts, now: () => nowMs });
    return { inspect, repair, close: live.close };
  }

  it("an interrupted restore's staging directory is reported, only removable once old, and removed by the repair; the kept previous installation is reported and never removed", async () => {
    const dataDir = targetAt("probe").dataDir;
    fs.mkdirSync(path.join(dataDir, ".restore-staging-abc", "files"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, ".restore-staging-abc", "app.db"), "half");
    fs.mkdirSync(path.join(dataDir, ".restore-previous-20260101-000000-xyz"), { recursive: true });
    const tool = await inspectAndRepair(dataDir, Date.now());

    const recent = await tool.inspect.execute();
    expect(recent.issues.find((issue) => issue.code === "interrupted-restore")).toMatchObject({ removable: false, repairable: false });
    expect(recent.issues.find((issue) => issue.code === "previous-installation")).toMatchObject({ severity: "warning", file: ".restore-previous-20260101-000000-xyz" });

    const later = await inspectAndRepair(dataDir, Date.now() + 2 * HOUR);
    const result = await later.repair.execute({});
    tool.close();
    later.close();

    expect(result.actions).toContainEqual({ kind: "removed-restore-staging", name: ".restore-staging-abc" });
    expect(leftovers(dataDir)).toEqual([".restore-previous-20260101-000000-xyz"]);
  });

  it("the artifact store refuses to remove anything that is not a restore artifact", async () => {
    const dataDir = targetAt("probe").dataDir;
    fs.mkdirSync(path.join(dataDir, "files"), { recursive: true });

    await expect(new DataDirectoryRestoreArtifacts(dataDir).remove("files")).rejects.toThrow(/not a restore artifact/);
    await expect(new DataDirectoryRestoreArtifacts(dataDir).remove("../outside")).rejects.toThrow(/not a restore artifact/);
    expect(fs.existsSync(path.join(dataDir, "files"))).toBe(true);
  });
});
