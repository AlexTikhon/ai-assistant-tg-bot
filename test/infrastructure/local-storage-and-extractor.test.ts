import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTextExtractor } from "../../src/infrastructure/documents/file-text-extractor.js";
import { LocalFileStorage } from "../../src/infrastructure/storage/local-file-storage.js";
import { ValidationError } from "../../src/shared/errors.js";

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

  it("keeps very long names within filesystem limits", async () => {
    const storage = new LocalFileStorage(directory);

    const storedName = await storage.save(`${"a".repeat(400)}.txt`, Buffer.from("x"));

    expect(storedName.length).toBeLessThan(200);
    expect(storedName.endsWith(".txt")).toBe(true);
  });
});

/** Smallest well-formed PDF with one page containing the text "Hello PDF world". */
function buildPdf(text: string) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 18 Tf 20 100 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 18 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((offset) => (pdf += `${String(offset).padStart(10, "0")} 00000 n \n`));
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

describe("FileTextExtractor", () => {
  const extractor = new FileTextExtractor();
  const input = (fileName: string, data: Buffer) => ({ fileName, mimeType: "application/octet-stream", data });

  it("decodes txt and md files as UTF-8", async () => {
    expect(await extractor.extract(input("a.txt", Buffer.from("Привет, мир")))).toBe("Привет, мир");
    expect(await extractor.extract(input("README.MD", Buffer.from("# Title")))).toBe("# Title");
  });

  it("extracts text from a PDF", async () => {
    const text = await extractor.extract(input("doc.pdf", buildPdf("Hello PDF world")));

    expect(text).toContain("Hello PDF world");
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
