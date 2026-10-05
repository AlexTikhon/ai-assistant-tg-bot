import { describe, expect, it } from "vitest";
import { prepareIndex } from "../../src/application/prepare-index.js";
import { MAX_SECTION_HEADINGS } from "../../src/core/markdown-sections.js";
import { FileTextExtractor } from "../../src/infrastructure/documents/file-text-extractor.js";
import { ValidationError } from "../../src/shared/errors.js";
import { KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";
import { buildPdf } from "../support/pdf.js";

const extractor = new FileTextExtractor();
const extract = (fileName: string, data: Buffer | string) => extractor.extract({ fileName, mimeType: "application/octet-stream", data: Buffer.from(data) });

describe("file type validation: the extension alone is not trusted", () => {
  it("accepts a real PDF", async () => {
    const result = await extract("report.pdf", buildPdf(["First page text", "Second page text"]));

    expect(result.text).toContain("First page text");
    expect(result.pages).toHaveLength(2);
  });

  it("rejects a file named .pdf that has no PDF signature - before the parser ever sees it", async () => {
    await expect(extract("report.pdf", "This is a plain text file renamed to .pdf")).rejects.toThrow(new ValidationError("This file is named like a PDF but is not a PDF document."));
    await expect(extract("report.pdf", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))).rejects.toThrow(/not a PDF document/);
    await expect(extract("report.pdf", Buffer.alloc(0))).rejects.toThrow(/not a PDF document/);
  });

  it("a PDF with the signature but a broken body is a clean, user-facing validation error", async () => {
    await expect(extract("report.pdf", "%PDF-1.4\nthis is not really a pdf")).rejects.toThrow(/Could not read the PDF/);
  });

  it("accepts text and Markdown", async () => {
    expect((await extract("notes.txt", "Plain notes")).text).toBe("Plain notes");
    expect((await extract("guide.md", "# Guide\n\nText")).text).toContain("# Guide");
  });

  it("rejects binary data presented as text", async () => {
    await expect(extract("notes.txt", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x08, 0x00]))).rejects.toThrow(/binary data/);
    await expect(extract("guide.md", Buffer.from("hi", "utf16le"))).rejects.toThrow(/binary data/);
  });

  it("rejects a PDF named .txt, and tells the user what to do", async () => {
    await expect(extract("notes.txt", "%PDF-1.4\n...")).rejects.toThrow(/is a PDF\. Send it with the \.pdf extension/);
  });

  it("rejects text that is not UTF-8", async () => {
    const latin1 = Buffer.from("Zürich café naïve résumé ".repeat(30), "latin1");

    await expect(extract("notes.txt", latin1)).rejects.toThrow(/not UTF-8/);
  });

  it("rejects an unsupported extension", async () => {
    await expect(extract("archive.zip", "x")).rejects.toThrow(/Unsupported file type/);
  });

  it("every rejection is a ValidationError, so users get its message and not a generic failure", async () => {
    for (const [name, data] of [["a.pdf", "text"], ["a.txt", Buffer.from([0, 1, 2])], ["a.txt", "%PDF-1.4"], ["a.exe", "x"]] as const) {
      await expect(extract(name, data)).rejects.toBeInstanceOf(ValidationError);
    }
  });
});

describe("resource bounds", () => {
  it("refuses a PDF with more pages than the limit, before extracting any text", async () => {
    const pdf = buildPdf(Array.from({ length: 6 }, (_, index) => `page ${index + 1}`));

    await expect(new FileTextExtractor({ maxPdfPages: 5 }).extract({ fileName: "big.pdf", mimeType: "application/pdf", data: pdf })).rejects.toThrow(/has 6 pages; the limit is 5/);
    await expect(new FileTextExtractor({ maxPdfPages: 6 }).extract({ fileName: "ok.pdf", mimeType: "application/pdf", data: pdf })).resolves.toMatchObject({ pages: expect.any(Array) });
  });

  const options = { chunkSize: 200, chunkOverlap: 20, maxChunksPerDocument: 5000 };
  const index = (text: string) => prepareIndex({ extractor: new Utf8Extractor(), embeddings: new KeywordEmbeddings() }, { fileName: "doc.md", mimeType: "text/markdown", data: Buffer.from(text) }, options);

  it("a Markdown file made of thousands of headings is indexed (cited by chunk number) instead of freezing the bot computing sections", async () => {
    const text = "# h\n".repeat(MAX_SECTION_HEADINGS + 1000) + "tail text about cats";
    const started = Date.now();

    const prepared = await index(text);

    expect(Date.now() - started).toBeLessThan(5000); // 480,000 headings used to take ~23 s
    expect(prepared.chunks.length).toBeGreaterThan(0);
    expect(prepared.chunks.every((chunk) => chunk.sectionPath === undefined)).toBe(true);
  });

  it("an ordinary document with sections keeps its section labels", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `## Section ${i}\n\nThis section talks about topic ${i} in some detail. `.repeat(2)).join("\n");

    const prepared = await index(text);

    expect(prepared.chunks.some((chunk) => chunk.sectionPath && chunk.sectionPath.length > 0)).toBe(true);
  });

  it("a single enormous line is split into bounded chunks and checked against the chunk limit before anything is embedded", async () => {
    const embeddings = new KeywordEmbeddings();

    await expect(
      prepareIndex({ extractor: new Utf8Extractor(), embeddings }, { fileName: "line.txt", mimeType: "text/plain", data: Buffer.from("a".repeat(2_000_000)) }, { ...options, maxChunksPerDocument: 100 }),
    ).rejects.toThrow(/too large to index/);
    expect(embeddings.documentCalls).toEqual([]); // nothing was sent to the provider
  });
});
