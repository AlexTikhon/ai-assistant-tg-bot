import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { createIntegrityTool } from "../../src/composition-root.js";
import { loadToolConfig } from "../../src/config/config.js";
import { openDatabase, openDatabaseReadOnly } from "../../src/infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { LocalFileStorage } from "../../src/infrastructure/storage/local-file-storage.js";
import { KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

let directory: string;
let config: ReturnType<typeof loadToolConfig>;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-integrity-"));
  config = loadToolConfig({ DATA_DIR: directory, OPENAI_EMBEDDINGS_MODEL: "test-model", CHUNK_SIZE: "200", CHUNK_OVERLAP: "20" });
  fs.mkdirSync(config.storage.filesDir, { recursive: true });

  const db = openDatabase(config.storage.sqlitePath, { legacyEmbeddingModel: "test-model" });
  const ingest = new IngestDocumentUseCase({
    documents: new SqliteDocumentRepository(db),
    files: new LocalFileStorage(config.storage.filesDir),
    extractor: new Utf8Extractor(),
    embeddings: new KeywordEmbeddings(),
    options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
  });
  await ingest.execute({ userId: "u1", fileName: "a.txt", mimeType: "text/plain", data: Buffer.from("The cat sleeps all day. ".repeat(20)) });
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  fs.writeFileSync(path.join(config.storage.filesDir, "stray.txt"), "no document refers to me");
  fs.writeFileSync(path.join(config.storage.filesDir, ".tmp-9-old.part"), "junk");
  const longAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(config.storage.filesDir, "stray.txt"), longAgo, longAgo);
  fs.utimesSync(path.join(config.storage.filesDir, ".tmp-9-old.part"), longAgo, longAgo);
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

const sha = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const snapshot = () => ({
  database: sha(config.storage.sqlitePath),
  files: fs.readdirSync(config.storage.filesDir).sort().map((name) => [name, sha(path.join(config.storage.filesDir, name))]),
});

describe("npm run integrity on a real database and directory", () => {
  it("a default check finds the problems and changes nothing on disk: not one byte of the database, not one file", async () => {
    const before = snapshot();
    const tool = createIntegrityTool(config, { writable: false, verifyHashes: true });

    const report = await tool.inspect.execute();
    tool.close();

    expect(report.issues.map((issue) => issue.code).sort()).toEqual(["orphan-file", "temporary-file"]);
    expect(snapshot()).toEqual(before);
    expect(tool.repair).toBeUndefined();
  });

  it("the read-only connection itself refuses writes", () => {
    const db = openDatabaseReadOnly(config.storage.sqlitePath);

    expect(() => db.exec("DELETE FROM documents")).toThrow(/readonly/i);
    expect(() => db.exec("INSERT INTO chunk_fts(chunk_fts) VALUES ('rebuild')")).toThrow();
    db.close();
  });

  it("refuses to open a database that has not been migrated, with a hint, instead of guessing", () => {
    const old = new Database(path.join(directory, "old.db"));
    old.pragma("user_version = 3");
    old.close();

    expect(() => openDatabaseReadOnly(path.join(directory, "old.db"))).toThrow(/schema version 3[\s\S]*migrate/);
    expect(() => openDatabaseReadOnly(path.join(directory, "missing.db"))).toThrow();
  });

  it("--repair removes only the stale temporary file; the orphan stays unless removal is explicitly requested", async () => {
    const tool = createIntegrityTool(config, { writable: true, verifyHashes: true });

    const first = await tool.repair!.execute({});
    expect(first.actions).toEqual([{ kind: "removed-temporary-file", file: ".tmp-9-old.part" }]);
    expect(fs.existsSync(path.join(config.storage.filesDir, "stray.txt"))).toBe(true);

    const second = await tool.repair!.execute({ removeOrphans: true });
    expect(second.actions).toEqual([{ kind: "removed-orphan-file", file: "stray.txt" }]);
    expect((await tool.inspect.execute()).issues).toEqual([]);
    tool.close();
  });
});
