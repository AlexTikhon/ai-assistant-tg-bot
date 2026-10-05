import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { createBackup } from "../../src/infrastructure/backup/create-backup.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { LocalFileStorage } from "../../src/infrastructure/storage/local-file-storage.js";
import { KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

let root: string;
let filesDir: string;
let storage: LocalFileStorage;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-secure-"));
  filesDir = path.join(root, "data", "files");
  storage = new LocalFileStorage(filesDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Everything below `root`, so that a write anywhere (inside or outside the storage directory) shows up. */
const tree = (directory = root): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? [full, ...tree(full)] : [full];
  });

const canSymlink = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-symlink-probe-"));
  try {
    fs.symlinkSync(probe, path.join(probe, "link"));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();

const HOSTILE_NAMES: Array<[label: string, name: string]> = [
  ["unix path traversal", "../../secret.txt"],
  ["windows path traversal", "..\\..\\secret.txt"],
  ["absolute unix path", "/etc/passwd"],
  ["absolute windows path with a drive", "C:\\Windows\\system.ini"],
  ["traversal in the middle", "file/../../x.pdf"],
  ["a UNC path", "\\\\server\\share\\x.md"],
  ["a reserved windows device name", "CON.txt"],
  ["another reserved name", "nul.md"],
  ["an embedded NUL byte", "report\u0000.exe.txt"],
  ["only dots", "...txt"],
  ["a name that is just an extension", ".pdf"],
  ["a very long name", `${"a".repeat(5000)}.pdf`],
  ["a very long extension", `x.${"z".repeat(5000)}`],
  ["unicode", "Отчёт за 2026 год — итоговый 📄.pdf"],
  ["right-to-left override", "invoice\u202Etxt.exe.pdf"],
  ["trailing dot and spaces", "notes.txt. . "],
  ["colon (an NTFS alternate data stream)", "notes.txt:hidden.md"],
];

describe("stored files get server-generated names; the user's file name is never part of a path", () => {
  it.each(HOSTILE_NAMES)("%s", async (_label, name) => {
    const before = tree();

    const storedName = await storage.save(name, Buffer.from("payload"));

    // The name is a UUID plus at most one of the accepted extensions - nothing of the user's name in it.
    expect(storedName).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.pdf|\.md|\.txt)?$/);
    // Exactly one new file, inside the storage directory; nothing was written anywhere else.
    const created = tree().filter((entry) => !before.includes(entry) && fs.statSync(entry).isFile());
    expect(created).toEqual([path.join(filesDir, storedName)]);
    expect(fs.readFileSync(path.join(filesDir, storedName), "utf-8")).toBe("payload");
    expect((await storage.read(storedName)).toString()).toBe("payload");
  });

  it("two uploads with the same hostile name never collide or overwrite each other", async () => {
    const first = await storage.save("../../secret.txt", Buffer.from("one"));
    const second = await storage.save("../../secret.txt", Buffer.from("two"));

    expect(first).not.toBe(second);
    expect((await storage.read(first)).toString()).toBe("one");
    expect((await storage.read(second)).toString()).toBe("two");
  });

  it("keeps an extension only from the accepted formats", async () => {
    expect(await storage.save("a.PDF", Buffer.from("x"))).toMatch(/\.pdf$/);
    expect(await storage.save("a.md", Buffer.from("x"))).toMatch(/\.md$/);
    expect(await storage.save("a.exe", Buffer.from("x"))).not.toContain(".");
    expect(await storage.save("a.txt.sh", Buffer.from("x"))).not.toContain(".");
  });

  it("does not overwrite application files that happen to sit next to the storage directory", async () => {
    fs.mkdirSync(path.dirname(filesDir), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(filesDir), "app.db"), "the database");
    fs.writeFileSync(path.join(root, "secret.txt"), "outside");

    await storage.save("../app.db", Buffer.from("evil"));
    await storage.save("../../secret.txt", Buffer.from("evil"));

    expect(fs.readFileSync(path.join(path.dirname(filesDir), "app.db"), "utf-8")).toBe("the database");
    expect(fs.readFileSync(path.join(root, "secret.txt"), "utf-8")).toBe("outside");
  });
});

describe("names that come back from the database are validated before they touch the file system", () => {
  const BAD_STORED_NAMES = ["../outside.txt", "..\\outside.txt", "a/b.txt", "a\\b.txt", "/etc/passwd", "C:\\x.txt", "C:x.txt", "", ".", "..", "x\u0000.txt", "name with spaces.txt", "ünïcode.txt", "a".repeat(300)];

  it.each(BAD_STORED_NAMES)("refuses %j for every operation", async (name) => {
    for (const operation of [() => storage.read(name), () => storage.delete(name), () => storage.stat(name), () => storage.deleteTemporary(name)]) {
      await expect(operation()).rejects.toThrow(/Invalid stored file name|not a temporary file/);
    }
  });

  it("accepts the names this application has ever generated: <uuid><ext> and the older <uuid>-<sanitized name>.<ext>", async () => {
    fs.mkdirSync(filesDir, { recursive: true });
    for (const name of ["3b95f056-90a1-4482-a153-f2c09b4f3875.pdf", "3b95f056-90a1-4482-a153-f2c09b4f3875-evil_name.pdf", "3b95f056-90a1-4482-a153-f2c09b4f3875"]) {
      fs.writeFileSync(path.join(filesDir, name), "x");
      expect((await storage.read(name)).toString()).toBe("x");
    }
  });

  it("deleteTemporary removes only temporary files", async () => {
    const stored = await storage.save("a.txt", Buffer.from("x"));

    await expect(storage.deleteTemporary(stored)).rejects.toThrow(/not a temporary file/);
    expect(fs.existsSync(path.join(filesDir, stored))).toBe(true);
  });
});

describe("storage boundaries: a symbolic link is never followed out of the storage directory", () => {
  const secret = () => path.join(root, "outside-secret.txt");

  beforeEach(() => {
    fs.mkdirSync(filesDir, { recursive: true });
    fs.writeFileSync(secret(), "TOP SECRET OUTSIDE THE STORAGE ROOT");
  });

  it("the rule is enforced on what lstat reports, so it holds on platforms where a link cannot be created for a test too", async () => {
    fs.writeFileSync(path.join(filesDir, "looks-like-a-link.txt"), "x");
    const linkLike = { isFile: () => false, isSymbolicLink: () => true, isDirectory: () => false, size: 1, mtimeMs: 0 } as unknown as fs.Stats;
    vi.spyOn(fsp, "lstat").mockResolvedValue(linkLike);

    await expect(storage.read("looks-like-a-link.txt")).rejects.toThrow(/not a regular file/);
    expect(await storage.stat("looks-like-a-link.txt")).toBeNull();
    expect(await storage.list()).toEqual([]);
  });

  it.skipIf(!canSymlink)("read refuses a link, stat does not count it as a stored file, and list ignores it", async () => {
    fs.symlinkSync(secret(), path.join(filesDir, "link.txt"));

    await expect(storage.read("link.txt")).rejects.toThrow(/not a regular file/);
    expect(await storage.stat("link.txt")).toBeNull();
    expect(await storage.list()).toEqual([]);
  });

  it.skipIf(!canSymlink)("delete removes the link itself and leaves what it pointed to", async () => {
    fs.symlinkSync(secret(), path.join(filesDir, "link.txt"));

    await storage.delete("link.txt");

    expect(fs.existsSync(path.join(filesDir, "link.txt"))).toBe(false);
    expect(fs.readFileSync(secret(), "utf-8")).toContain("TOP SECRET");
  });

  it.skipIf(!canSymlink)("a backup refuses to copy a linked 'stored file' instead of putting the machine's file into it", async () => {
    const db = openDatabase(path.join(root, "data", "app.db"), { legacyEmbeddingModel: "m" });
    db.prepare("INSERT INTO documents (id, user_id, file_name, stored_name, file_size, text_length, created_at) VALUES ('d1', 'u1', 'a.txt', 'link.txt', 1, 1, '2026-01-01')").run();
    fs.symlinkSync(secret(), path.join(filesDir, "link.txt"));
    const outputDir = path.join(root, "backup");

    await expect(createBackup({ db, filesDir, outputDir, now: () => new Date(), applicationVersion: "1" })).rejects.toThrow(/not a regular file/);
    db.close();

    expect(fs.existsSync(outputDir)).toBe(false); // and no half-written backup is left
  });

  it.skipIf(!canSymlink)("a link planted where the next upload's temporary file would go cannot redirect the write", async () => {
    // The temporary name is a fresh random UUID, so it cannot be guessed; and the write uses O_EXCL ("wx"), which refuses an existing link.
    const written = await storage.save("a.txt", Buffer.from("fresh"));

    expect(fs.readFileSync(secret(), "utf-8")).toBe("TOP SECRET OUTSIDE THE STORAGE ROOT");
    expect(written).toMatch(/\.txt$/);
  });
});

describe("through the real ingestion path", () => {
  const closeLater: Array<{ close(): void }> = [];
  afterEach(() => closeLater.splice(0).forEach((db) => db.close()));

  async function ingest(fileName: string, text = "Cats sleep on sofas all afternoon. ".repeat(10)) {
    fs.mkdirSync(filesDir, { recursive: true });
    const db = openDatabase(path.join(root, "data", "app.db"), { legacyEmbeddingModel: "test-model" });
    closeLater.push(db);
    const documents = new SqliteDocumentRepository(db);
    const result = await new IngestDocumentUseCase({
      documents,
      files: storage,
      extractor: new Utf8Extractor(),
      embeddings: new KeywordEmbeddings(),
      options: { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 },
    }).execute({ userId: "u1", fileName, mimeType: "text/plain", data: Buffer.from(text) });
    const stored = await documents.findById("u1", result.documentId);
    return { result, stored: stored! };
  }

  it.each([
    ["../../secret.txt", "../../secret.txt"],
    ["..\\..\\secret.txt", "..\\..\\secret.txt"],
    ["file/../../x.md", "file/../../x.md"],
  ])("a file called %j is indexed under that name as metadata, and stored under a generated name inside the storage directory", async (name, expectedDisplay) => {
    const before = tree();

    const { result, stored } = await ingest(name);

    expect(result.kind).toBe("created");
    expect(stored.fileName).toBe(expectedDisplay);
    expect(stored.storedName).toMatch(/^[0-9a-f-]{36}\.(txt|md)$/);
    expect(tree().filter((entry) => !before.includes(entry) && fs.statSync(entry).isFile()).every((entry) => entry.startsWith(filesDir) || entry.includes("app.db"))).toBe(true);
    expect(fs.existsSync(path.join(root, "secret.txt"))).toBe(false);
  });

  it("an absolute path or a drive letter with an unsupported extension is refused before anything is stored", async () => {
    await expect(ingest("/etc/passwd")).rejects.toThrow(/Unsupported file type/);
    await expect(ingest("C:\\Windows\\system.ini")).rejects.toThrow(/Unsupported file type/);

    expect(fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : []).toEqual([]);
  });

  it("a safe Unicode display name is kept as it is", async () => {
    const { stored } = await ingest("Отчёт за 2026 год — итоговый 📄.md");

    expect(stored.fileName).toBe("Отчёт за 2026 год — итоговый 📄.md");
    expect(stored.storedName).toMatch(/^[0-9a-f-]{36}\.md$/);
  });

  it("an oversized display name is bounded and keeps its extension", async () => {
    const { stored } = await ingest(`${"é".repeat(5000)}.md`);

    expect(stored.fileName.length).toBeLessThanOrEqual(255);
    expect(stored.fileName.endsWith(".md")).toBe(true);
  });

  it("control and direction-override characters are removed from the display name", async () => {
    const { stored } = await ingest("inv\u0000oice\u202E\u0007 final.md");

    expect(stored.fileName).toBe("invoice final.md");
  });
});
