import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalFileStorage } from "../../src/infrastructure/storage/local-file-storage.js";

let directory: string;
let storage: LocalFileStorage;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-storage-lifecycle-"));
  storage = new LocalFileStorage(directory);
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("LocalFileStorage write protocol", () => {
  it("never leaves a temporary file behind after a successful save", async () => {
    await storage.save("a.txt", Buffer.from("bytes"));

    expect((await storage.list()).map((entry) => entry.kind)).toEqual(["stored"]);
  });

  it("reports the size of a stored file without reading it, and null for a missing one", async () => {
    const name = await storage.save("a.txt", Buffer.from("12345"));

    expect(await storage.stat(name)).toEqual({ size: 5 });
    expect(await storage.stat("gone.txt")).toBeNull();
    await expect(storage.stat("../outside.txt")).rejects.toThrow(/Invalid stored file name/);
  });

  it("recognises the leftover of an interrupted write as temporary, with its age inputs", async () => {
    const kept = await storage.save("kept.txt", Buffer.from("kept"));
    const leftover = path.join(directory, ".tmp-1234-upload.pdf.part");
    fs.writeFileSync(leftover, "half a fi");
    fs.mkdirSync(path.join(directory, "unrelated-directory"));

    const entries = await storage.list();

    expect(entries.map((entry) => [entry.name, entry.kind]).sort()).toEqual([
      [".tmp-1234-upload.pdf.part", "temporary"],
      [kept, "stored"],
    ]);
    const temporary = entries.find((entry) => entry.kind === "temporary")!;
    expect(temporary.size).toBe(9);
    expect(temporary.modifiedAtMs).toBeGreaterThan(0);
  });

  it("an empty or missing directory lists nothing", async () => {
    expect(await new LocalFileStorage(path.join(directory, "not-created-yet")).list()).toEqual([]);
  });

  it("deletes temporary files only: a committed document file can never be removed through that door", async () => {
    const stored = await storage.save("a.txt", Buffer.from("precious"));
    fs.writeFileSync(path.join(directory, ".tmp-1-x.part"), "junk");

    await storage.deleteTemporary(".tmp-1-x.part");
    await expect(storage.deleteTemporary(stored)).rejects.toThrow(/not a temporary file/);
    await expect(storage.deleteTemporary("../.tmp-x.part")).rejects.toThrow(/Invalid stored file name/);

    expect((await storage.list()).map((entry) => entry.name)).toEqual([stored]);
  });

  it("deleting a temporary file that is already gone is not an error", async () => {
    await expect(storage.deleteTemporary(".tmp-1-gone.part")).resolves.toBeUndefined();
  });
});
