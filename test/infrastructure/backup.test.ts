import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { createBackup } from "../../src/infrastructure/backup/create-backup.js";
import { BACKUP_FORMAT_VERSION, MANIFEST_FILE, parseManifest } from "../../src/infrastructure/backup/manifest.js";
import { verifyBackup } from "../../src/infrastructure/backup/verify-backup.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { LATEST_SCHEMA_VERSION } from "../../src/infrastructure/sqlite/migrations.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { LocalFileStorage } from "../../src/infrastructure/storage/local-file-storage.js";
import { KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

const NOW = new Date("2026-03-10T12:00:00.000Z");
const recipe = { embeddingModel: "test-model", chunkSize: 200, chunkOverlap: 20 };

let root: string;
let dataDir: string;
let filesDir: string;
let sqlitePath: string;
let backupDir: string;
let db: Database.Database;

const SECRET = "sk-test-SECRET-do-not-leak-0123456789";

async function ingest(fileName: string, text: string, userId = "u1") {
  const result = await new IngestDocumentUseCase({
    documents: new SqliteDocumentRepository(db),
    files: new LocalFileStorage(filesDir),
    extractor: new Utf8Extractor(),
    embeddings: new KeywordEmbeddings(),
    options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
  }).execute({ userId, fileName, mimeType: "text/plain", data: Buffer.from(text) });
  return result.documentId;
}

const backup = (output = backupDir) => createBackup({ db, filesDir, outputDir: output, now: () => NOW, applicationVersion: "1.2.3" });
const verify = (directory = backupDir) => verifyBackup(directory, { recipe, now: () => NOW.getTime() });

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-backup-"));
  dataDir = path.join(root, "data");
  filesDir = path.join(dataDir, "files");
  sqlitePath = path.join(dataDir, "app.db");
  backupDir = path.join(root, "backups", "bot-backup-1");
  fs.mkdirSync(filesDir, { recursive: true });
  // Things that must never end up in a backup, next to the data and in the working directory.
  fs.writeFileSync(path.join(root, ".env"), `OPENAI_API_KEY=${SECRET}\nTELEGRAM_BOT_TOKEN=123456:SECRET-TOKEN\n`);
  fs.writeFileSync(path.join(dataDir, "bot.log"), `{"msg":"token ${SECRET}"}\n`);
  fs.writeFileSync(path.join(dataDir, ".env"), `OPENAI_API_KEY=${SECRET}\n`);

  db = openDatabase(sqlitePath, { legacyEmbeddingModel: "test-model" });
  await ingest("a.txt", "The cat sleeps all day on the sofa. ".repeat(10));
  await ingest("b.txt", "Quarterly tax forms are due in April. ".repeat(10));
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("backup content", () => {
  it("produces a database snapshot that opens and can be queried", async () => {
    await backup();

    const copy = new Database(path.join(backupDir, "app.db"), { readonly: true });
    expect(copy.pragma("quick_check", { simple: true })).toBe("ok");
    expect(copy.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(copy.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 2 });
    expect(copy.prepare("SELECT COUNT(*) AS n FROM chunk_fts WHERE chunk_fts MATCH 'tax'").get()).toMatchObject({ n: expect.any(Number) });
    copy.close();
  });

  it("writes a manifest that describes it", async () => {
    const manifest = await backup();

    expect(manifest).toMatchObject({
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: "2026-03-10T12:00:00.000Z",
      application: { version: "1.2.3" },
      schemaVersion: LATEST_SCHEMA_VERSION,
      counts: { documents: 2, files: 2 },
      missingFiles: [],
    });
    expect(manifest.counts.chunks).toBeGreaterThan(2);
    expect(manifest.indexProfiles).toEqual([{ fingerprint: expect.stringMatching(/^[0-9a-f]{12}$/), profile: expect.objectContaining({ embeddingModel: "test-model", chunkSize: 200 }), documents: 2 }]);
    expect(parseManifest(fs.readFileSync(path.join(backupDir, MANIFEST_FILE), "utf-8"))).toEqual(manifest);
  });

  it("includes every file the database refers to, byte for byte, with its hash", async () => {
    const manifest = await backup();

    expect(manifest.files).toHaveLength(2);
    for (const file of manifest.files) {
      const original = fs.readFileSync(path.join(filesDir, file.storedName));
      const copy = fs.readFileSync(path.join(backupDir, "files", file.storedName));
      expect(copy.equals(original)).toBe(true);
      expect(file).toMatchObject({ bytes: original.byteLength, sha256: createHash("sha256").update(original).digest("hex") });
    }
  });

  it("leaves out files that no document refers to", async () => {
    fs.writeFileSync(path.join(filesDir, "stray.txt"), "orphan");

    await backup();

    expect(fs.existsSync(path.join(backupDir, "files", "stray.txt"))).toBe(false);
  });

  it("never contains .env, logs, API keys or tokens: only the database, the referenced files and the manifest", async () => {
    await backup();

    const names = walk(backupDir).map((file) => path.relative(backupDir, file).replace(/\\/g, "/"));
    expect(names.filter((name) => !name.startsWith("files/")).sort()).toEqual(["app.db", "manifest.json"]);
    expect(names.some((name) => /\.env|\.log$/.test(name))).toBe(false);
    for (const file of walk(backupDir)) {
      const content = fs.readFileSync(file, "latin1");
      expect(content, file).not.toContain(SECRET);
      expect(content, file).not.toContain("SECRET-TOKEN");
    }
  });

  it("fails an incomplete backup by default; partial recovery needs an explicit flag at creation and verification", async () => {
    const stored = (db.prepare("SELECT stored_name AS name FROM documents ORDER BY created_at LIMIT 1").get() as { name: string }).name;
    fs.rmSync(path.join(filesDir, stored));

    await expect(backup()).rejects.toThrow(/Backup is incomplete/);
    expect(fs.existsSync(backupDir)).toBe(false);
    const manifest = await createBackup({ db, filesDir, outputDir: backupDir, now: () => NOW, applicationVersion: "1.2.3", allowIncomplete: true });

    expect(manifest.missingFiles).toEqual([stored]);
    expect(manifest.counts.files).toBe(1);
    expect((await verify()).ok).toBe(false);
    expect((await verifyBackup(backupDir, { recipe, now: () => NOW.getTime(), allowIncomplete: true })).ok).toBe(true);
  });

  it("blocks mutations in another process after the snapshot until originals are copied, then releases the barrier", async () => {
    const writer = openDatabase(sqlitePath, { legacyEmbeddingModel: "test-model" });
    writer.pragma("busy_timeout = 1");
    const actualBackup = db.backup.bind(db);
    const spy = vi.spyOn(db, "backup").mockImplementation(async (...args) => {
      const result = await actualBackup(...args);
      const output = execFileSync(process.execPath, ["-e", "const Database=require('better-sqlite3');const db=new Database(process.argv[1]);db.pragma('busy_timeout=20');try{db.prepare('DELETE FROM documents').run();console.log('deleted');}catch(e){console.log(e.code);}finally{db.close();}", sqlitePath], { cwd: process.cwd(), encoding: "utf8" });
      expect(output.trim()).toBe("SQLITE_BUSY");
      expect(writer.prepare("SELECT COUNT(*) AS n FROM documents").get()).toEqual({ n: 2 });
      return result;
    });
    try {
      await backup();
      expect((await verify()).ok).toBe(true);
      expect(writer.prepare("DELETE FROM documents").run().changes).toBe(2);
    } finally {
      spy.mockRestore();
      writer.close();
    }
  });
});

describe("backup safety", () => {
  it("refuses to write into a directory that already has content", async () => {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, "keep.txt"), "mine");

    await expect(backup()).rejects.toThrow(/not empty/);
    expect(fs.readFileSync(path.join(backupDir, "keep.txt"), "utf-8")).toBe("mine");
  });

  it("accepts an existing empty directory", async () => {
    fs.mkdirSync(backupDir, { recursive: true });

    await expect(backup()).resolves.toBeDefined();
  });

  it("removes what it created when it fails, so an incomplete backup cannot be mistaken for a complete one", async () => {
    fs.writeFileSync(path.join(filesDir, "x"), "x");
    const broken = { ...db, backup: async () => Promise.reject(new Error("disk full")) } as unknown as Database.Database;

    await expect(createBackup({ db: broken, filesDir, outputDir: backupDir, now: () => NOW, applicationVersion: "1" })).rejects.toThrow("disk full");

    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it("refuses a stored file name that would escape the files directory", async () => {
    db.prepare("UPDATE documents SET stored_name = '../app.db' WHERE rowid = 1").run();

    await expect(backup()).rejects.toThrow(/Invalid stored file name/);
    expect(fs.existsSync(backupDir)).toBe(false);
  });
});

describe("backup verification", () => {
  it("accepts a good backup and reports what it checked", async () => {
    await backup();

    const result = await verify();

    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toMatchObject({ documents: 2, files: 2 });
  });

  it("detects a file that is missing from the backup", async () => {
    const manifest = await backup();
    fs.rmSync(path.join(backupDir, "files", manifest.files[0].storedName));

    const result = await verify();

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain(`missing from the backup: ${manifest.files[0].storedName}`);
  });

  it("detects a file whose content changed (hash mismatch), even when its size did not", async () => {
    const manifest = await backup();
    const target = path.join(backupDir, "files", manifest.files[0].storedName);
    fs.writeFileSync(target, Buffer.from("Z".repeat(manifest.files[0].bytes)));

    const result = await verify();

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/hash mismatch/i);
  });

  it("detects a database that was altered after the backup was made", async () => {
    await backup();
    const tampered = new Database(path.join(backupDir, "app.db"));
    tampered.pragma("journal_mode = DELETE");
    tampered.prepare("UPDATE documents SET file_name = 'changed.txt'").run();
    tampered.close();

    const result = await verify();

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/database.*(hash|checksum)/i);
  });

  it("detects a document whose recorded content hash does not match its file", async () => {
    const manifest = await backup();
    // Same bytes in the manifest and on disk, but the database claims a different original.
    const copy = new Database(path.join(backupDir, "app.db"));
    copy.pragma("journal_mode = DELETE");
    copy.prepare("UPDATE documents SET content_hash = ? WHERE stored_name = ?").run("0".repeat(64), manifest.files[0].storedName);
    copy.close();
    const rewritten = { ...manifest, database: { ...manifest.database, sha256: createHash("sha256").update(fs.readFileSync(path.join(backupDir, "app.db"))).digest("hex"), bytes: fs.statSync(path.join(backupDir, "app.db")).size } };
    fs.writeFileSync(path.join(backupDir, MANIFEST_FILE), JSON.stringify(rewritten));

    const result = await verify();

    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/content hash/i);
  });

  it("detects files in the backup that the manifest does not know (warning) and a missing or invalid manifest (problem)", async () => {
    await backup();
    fs.writeFileSync(path.join(backupDir, "files", "unexpected.txt"), "extra");
    expect((await verify()).warnings.join("\n")).toContain("unexpected.txt");

    fs.writeFileSync(path.join(backupDir, MANIFEST_FILE), "{ not json");
    expect((await verify()).problems.join("\n")).toMatch(/manifest/i);
    fs.rmSync(path.join(backupDir, MANIFEST_FILE));
    expect((await verify()).problems.join("\n")).toMatch(/manifest.*missing|no manifest/i);
  });

  it("runs the integrity checks on the backup copy and reports what they find", async () => {
    db.prepare("DELETE FROM document_chunks WHERE rowid = (SELECT MIN(rowid) FROM document_chunks)").run();
    await backup();

    const result = await verify();

    expect(result.integrity?.issues.map((issue) => issue.code)).toContain("chunk-index-gap");
    expect(result.ok).toBe(false);
  });

  it("does not modify the backup it verifies", async () => {
    await backup();
    const before = walk(backupDir).map((file) => [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);

    await verify();

    expect(walk(backupDir).map((file) => [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")])).toEqual(before);
  });
});
