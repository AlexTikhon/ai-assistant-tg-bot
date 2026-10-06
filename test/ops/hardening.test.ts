import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { RecordFeedbackUseCase } from "../../src/application/use-cases/record-feedback.use-case.js";
import { createBackup } from "../../src/infrastructure/backup/create-backup.js";
import { InMemoryAnswerOutcomes } from "../../src/infrastructure/memory/answer-outcomes.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteFeedbackStore } from "../../src/infrastructure/sqlite/sqlite-feedback-store.js";
import { LocalFileStorage } from "../../src/infrastructure/storage/local-file-storage.js";
import { restoreBackup } from "../../src/infrastructure/backup/restore-backup.js";
import { KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

const SRC = path.join(__dirname, "..", "..", "src");
const sources = (directory = SRC): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? sources(path.join(directory, entry.name)) : entry.name.endsWith(".ts") ? [path.join(directory, entry.name)] : []));

/** The source text between the parentheses of the call that starts at `open` (the index of "("). */
function callArguments(text: string, open: number) {
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && (depth -= 1) === 0) return text.slice(open + 1, index);
  }
  return text.slice(open + 1);
}

describe("logging rule: what may be logged (docs/security.md)", () => {
  /** Field names that must never be logged as a value: user text, answers, document or chunk text, vectors, secrets. */
  const FORBIDDEN_KEYS = ["content", "text", "answer", "prompt", "context", "embedding", "embeddings", "vector", "chunkText", "caption", "transcript", "summary", "botToken", "apiKey", "token", "authorization", "password"];
  // A key with a numeric value is a count (`calls: { embedding: 1 }`), not content.
  const FIELD = new RegExp(`(?:^|[{,\\s])(${FORBIDDEN_KEYS.join("|")})\\s*(?::(?!\\s*\\d)|,|\\})`);

  const logCalls = sources().flatMap((file) => {
    const text = fs.readFileSync(file, "utf-8");
    return [...text.matchAll(/\b(?:this\.)?(?:log|logger)\.(?:info|warn|error|fatal|debug)\(/g)].map((match) => ({
      file: path.relative(SRC, file).replace(/\\/g, "/"),
      args: callArguments(text, match.index + match[0].length - 1),
    }));
  });

  it("finds the log calls it is meant to guard", () => {
    expect(logCalls.length).toBeGreaterThan(40);
  });

  it("no log call puts user text, document text, answers, vectors or secrets into a field", () => {
    const offenders = logCalls
      .filter((call) => !call.file.startsWith("eval/") && !call.file.startsWith("cli/"))
      .map((call) => {
        const fields = /^\s*\{([\s\S]*?)\}\s*,/.exec(call.args)?.[1] ?? "";
        // The one opt-in development switch (LOG_QUESTIONS) is removed before looking.
        const checked = fields.replace(/\.\.\.\((?:this\.deps\.)?options\?\.logQuestions[\s\S]*?\{\s*question\s*\}[^)]*\)/g, "");
        return { call, hit: FIELD.exec(checked)?.[0] };
      })
      .filter(({ hit }) => hit !== undefined)
      .map(({ call, hit }) => `${call.file}: found "${hit?.trim()}" in ${call.args.slice(0, 80).replace(/\s+/g, " ")}`);

    expect(offenders).toEqual([]);
  });

  it("the question text is only ever logged behind the explicit LOG_QUESTIONS switch", () => {
    const answerUseCase = fs.readFileSync(path.join(SRC, "application/use-cases/answer-question.use-case.ts"), "utf-8");
    const occurrences = [...answerUseCase.matchAll(/\{\s*question\s*\}/g)];

    expect(occurrences.length).toBeGreaterThan(0);
    for (const match of occurrences) {
      expect(answerUseCase.slice(Math.max(0, match.index - 80), match.index)).toMatch(/logQuestions/);
    }
  });
});

describe("operational commands", () => {
  it.each(["backup", "backup-verify", "integrity", "reindex", "restore", "diagnostics", "db-maintenance"])("%s limits the JSON application log to warnings so its own report is readable, before the logger is loaded", (name) => {
    const imports = fs.readFileSync(path.join(SRC, "cli", `${name}.ts`), "utf-8").split("\n").filter((line) => line.startsWith("import "));

    expect(imports.slice(0, 2)).toEqual(['import "dotenv/config";', 'import "./quiet-logs.js";']);
  });
});

describe("file permissions of what the application creates (Linux and containers)", () => {
  const posix = process.platform !== "win32";
  const mode = (file: string) => fs.statSync(file).mode & 0o777;

  it.skipIf(!posix)("the database, stored files, backups and the data directories are private to the owner", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-perm-"));
    try {
      const filesDir = path.join(root, "data", "files");
      fs.mkdirSync(filesDir, { recursive: true });
      const db = openDatabase(path.join(root, "data", "app.db"), { legacyEmbeddingModel: "test-model" });
      await new IngestDocumentUseCase({
        documents: new SqliteDocumentRepository(db),
        files: new LocalFileStorage(path.join(root, "data", "newfiles")),
        extractor: new Utf8Extractor(),
        embeddings: new KeywordEmbeddings(),
        options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
      }).execute({ userId: "u", fileName: "a.txt", mimeType: "text/plain", data: Buffer.from("The cat sleeps all day on the sofa. ".repeat(10)) });
      const outputDir = path.join(root, "backup");
      await createBackup({ db, filesDir: path.join(root, "data", "newfiles"), outputDir, now: () => new Date(), applicationVersion: "1" });
      db.close();

      expect(mode(path.join(root, "data", "app.db"))).toBe(0o600);
      expect(mode(path.join(root, "data", "newfiles"))).toBe(0o700);
      for (const file of fs.readdirSync(path.join(root, "data", "newfiles"))) expect(mode(path.join(root, "data", "newfiles", file))).toBe(0o600);
      expect(mode(outputDir)).toBe(0o700);
      expect(mode(path.join(outputDir, "files"))).toBe(0o700);
      expect(mode(path.join(outputDir, "app.db"))).toBe(0o600);
      expect(mode(path.join(outputDir, "manifest.json"))).toBe(0o600);

      const target = { dataDir: path.join(root, "restored"), filesDir: path.join(root, "restored", "files"), sqlitePath: path.join(root, "restored", "app.db") };
      await restoreBackup({ backupDir: outputDir, target, replaceExisting: false, recipe: { embeddingModel: "test-model", chunkSize: 200, chunkOverlap: 20 }, legacyEmbeddingModel: "test-model", now: () => new Date() });
      expect(mode(target.sqlitePath)).toBe(0o600);
      expect(mode(target.dataDir)).toBe(0o700);
      for (const file of fs.readdirSync(target.filesDir)) expect(mode(path.join(target.filesDir, file))).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("nothing in the application sets a world-writable or world-readable mode", () => {
    const offenders = sources().filter((file) => /0o[0-7]*[2-7][0-7]?\b|mode:\s*0o[0-7]{3}/.test(fs.readFileSync(file, "utf-8").replace(/0o600|0o700/g, "")));

    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });
});

describe("temporary files and directories are controlled, unique and discoverable", () => {
  it("every temporary artifact name is generated from a random UUID, so two operations never share one", () => {
    const storage = fs.readFileSync(path.join(SRC, "infrastructure/storage/local-file-storage.ts"), "utf-8");
    const restore = fs.readFileSync(path.join(SRC, "infrastructure/backup/restore-backup.ts"), "utf-8");

    expect(storage).toMatch(/TEMP_PREFIX\}\$\{randomUUID\(\)\}/);
    expect(restore).toMatch(/newId \?\? randomUUID/);
    expect(restore).toMatch(/STAGING_PREFIX\}\$\{id\}/);
  });

  it("temporary files and the restore staging area live inside the data directory (same filesystem as the data), never in a shared /tmp", () => {
    const restore = fs.readFileSync(path.join(SRC, "infrastructure/backup/restore-backup.ts"), "utf-8");
    const storage = fs.readFileSync(path.join(SRC, "infrastructure/storage/local-file-storage.ts"), "utf-8");

    expect(restore).toMatch(/path\.join\(target\.dataDir, `\$\{STAGING_PREFIX\}/);
    expect(storage).toMatch(/path\.join\(this\.directory, `\$\{TEMP_PREFIX\}/);
    for (const file of sources().filter((candidate) => !/\/(cli|eval)\//.test(candidate.replace(/\\/g, "/")))) {
      expect(fs.readFileSync(file, "utf-8"), path.relative(SRC, file)).not.toMatch(/os\.tmpdir\(\)|\/tmp\b/);
    }
  });

  it("an interrupted ingestion write is discoverable as a temporary file by the integrity check (and not mistaken for a stored file)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-temp-"));
    try {
      const storage = new LocalFileStorage(root);
      fs.writeFileSync(path.join(root, ".tmp-0f0f0f0f-0000-4000-8000-000000000000.part"), "half a file");
      await storage.save("a.txt", Buffer.from("done"));

      const entries = await storage.list();

      expect(entries.filter((entry) => entry.kind === "temporary").map((entry) => entry.name)).toEqual([".tmp-0f0f0f0f-0000-4000-8000-000000000000.part"]);
      expect(entries.filter((entry) => entry.kind === "stored")).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("feedback storage", () => {
  const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-feedback-"));

  it("stores only a rating, the request id, the owner and the gate's labels and score - no text, and no reference to a document", () => {
    const directory = root();
    try {
      const db = openDatabase(path.join(directory, "app.db"), { legacyEmbeddingModel: "m" });
      const columns = (db.prepare("PRAGMA table_info(answer_feedback)").all() as Array<{ name: string }>).map((column) => column.name);
      const foreignKeys = db.prepare("PRAGMA foreign_key_list(answer_feedback)").all();
      db.close();

      expect(columns).toEqual(["id", "request_id", "user_id", "rating", "created_at", "confidence_mode", "decision", "reason", "shadow_decision", "shadow_reason", "top_semantic_score"]);
      expect(foreignKeys).toEqual([]); // it points at no document and no chunk, so deleting one can never leave a broken reference
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deleting documents leaves feedback intact and valid: the database passes its foreign key check", async () => {
    const directory = root();
    try {
      fs.mkdirSync(path.join(directory, "files"));
      const db = openDatabase(path.join(directory, "app.db"), { legacyEmbeddingModel: "test-model" });
      const documents = new SqliteDocumentRepository(db);
      const ingested = await new IngestDocumentUseCase({
        documents,
        files: new LocalFileStorage(path.join(directory, "files")),
        extractor: new Utf8Extractor(),
        embeddings: new KeywordEmbeddings(),
        options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
      }).execute({ userId: "u1", fileName: "a.txt", mimeType: "text/plain", data: Buffer.from("The cat sleeps all day on the sofa. ".repeat(10)) });
      const outcomes = new InMemoryAnswerOutcomes();
      outcomes.record("abcd1234", { mode: "shadow", decision: "answer", reason: "enough-evidence", shadowDecision: "abstain", shadowReason: "weak-semantic", topSemanticScore: 0.31 } as never);
      await new RecordFeedbackUseCase({ store: new SqliteFeedbackStore(db), outcomes }).execute({ userId: "u1", requestId: "abcd1234", rating: "good" });

      await documents.delete("u1", ingested.documentId);

      expect(db.prepare("SELECT COUNT(*) AS n FROM answer_feedback").get()).toEqual({ n: 1 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      db.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
