import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTextExtractor } from "../../src/infrastructure/documents/file-text-extractor.js";
import { LocalFileStorage } from "../../src/infrastructure/storage/local-file-storage.js";
import { ValidationError } from "../../src/shared/errors.js";
import { buildPdf } from "../support/pdf.js";

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-storage-"));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("LocalFileStorage", () => {
  it("saves under a sanitized, unique name and deletes by that name", async () => {
    const storage = new LocalFileStorage(path.join(directory, "files"));

    const first = await storage.save("../../evil name!.PDF", Buffer.from("one"));
    const second = await storage.save("../../evil name!.PDF", Buffer.from("two"));

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[0-9a-f-]{36}-evil_name\.pdf$/);
    expect(fs.readdirSync(path.join(directory, "files")).sort()).toEqual([first, second].sort());
    expect(fs.readFileSync(path.join(directory, "files", first), "utf-8")).toBe("one");

    await storage.delete(first);
    expect(fs.readdirSync(path.join(directory, "files"))).toEqual([second]);
  });

  it("ignores missing files on delete but refuses path traversal", async () => {
    const storage = new LocalFileStorage(directory);

    await expect(storage.delete("does-not-exist.txt")).resolves.toBeUndefined();
    await expect(storage.delete("../outside.txt")).rejects.toThrow(/Invalid stored file name/);
  });

  it("reads back what was saved, and refuses path traversal and missing files", async () => {
    const storage = new LocalFileStorage(directory);
    const storedName = await storage.save("a.txt", Buffer.from("original bytes"));

    expect((await storage.read(storedName)).toString()).toBe("original bytes");
    await expect(storage.read("../outside.txt")).rejects.toThrow(/Invalid stored file name/);
    await expect(storage.read("missing.txt")).rejects.toThrow(/ENOENT/);
  });

  it("keeps very long names within filesystem limits", async () => {
    const storage = new LocalFileStorage(directory);

    const storedName = await storage.save(`${"a".repeat(400)}.txt`, Buffer.from("x"));

    expect(storedName.length).toBeLessThan(200);
    expect(storedName.endsWith(".txt")).toBe(true);
  });
});

describe("FileTextExtractor", () => {
  const extractor = new FileTextExtractor();
  const input = (fileName: string, data: Buffer) => ({ fileName, mimeType: "application/octet-stream", data });

  it("decodes txt and md files as UTF-8", async () => {
    expect(await extractor.extract(input("a.txt", Buffer.from("Привет, мир")))).toEqual({ text: "Привет, мир" });
    expect(await extractor.extract(input("README.MD", Buffer.from("# Title")))).toEqual({ text: "# Title" });
  });

  it("extracts text from a PDF", async () => {
    const { text } = await extractor.extract(input("doc.pdf", buildPdf(["Hello PDF world"])));

    expect(text).toContain("Hello PDF world");
  });

  it("returns the text of every PDF page under its real page number, without page-marker noise", async () => {
    const { pages, text } = await extractor.extract(
      input("doc.pdf", buildPdf(["First page text", "Second page text", "Third page text"])),
    );

    expect(pages?.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(pages?.map((page) => page.text.trim())).toEqual(["First page text", "Second page text", "Third page text"]);
    expect(text).toContain("Second page text");
    expect(text).not.toMatch(/-- \d+ of \d+ --/);
    expect(pages?.some((page) => /-- \d+ of \d+ --/.test(page.text))).toBe(false);
  });

  it("has no page information for text files", async () => {
    expect((await extractor.extract(input("a.md", Buffer.from("x")))).pages).toBeUndefined();
  });

  it("reports unreadable PDFs as a validation error", async () => {
    await expect(extractor.extract(input("broken.pdf", Buffer.from("definitely not a pdf")))).rejects.toThrow(
      ValidationError,
    );
  });

  it("rejects other file types", async () => {
    await expect(extractor.extract(input("a.exe", Buffer.from("x")))).rejects.toThrow(ValidationError);
  });
});
