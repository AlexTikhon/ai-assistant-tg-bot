import { beforeEach, describe, expect, it } from "vitest";
import type { DocumentRepository } from "../../src/application/ports/document-repository.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { ValidationError } from "../../src/shared/errors.js";
import { buildIndexProfile } from "../../src/core/index-profile.js";
import { createTestStores, InMemoryFileStorage, KeywordEmbeddings, PAGE_BREAK, Utf8Extractor } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;
let embeddings: KeywordEmbeddings;

const options = {
  maxUploadBytes: 1024,
  chunkSize: 200,
  chunkOverlap: 20,
  maxDocumentsPerUser: 10,
  maxStorageBytesPerUser: 1_000_000,
  maxChunksPerDocument: 100,
};

function createUseCase(documents: DocumentRepository = stores.documents, overrides: Partial<typeof options> = {}) {
  return new IngestDocumentUseCase({
    documents,
    files,
    extractor: new Utf8Extractor(),
    embeddings,
    options: { ...options, ...overrides },
  });
}

/** Identical bytes are one document for the same user, so by default every file name gets its own content. */
const upload = (overrides: Partial<{ userId: string; fileName: string; text: string }> = {}) => {
  const fileName = overrides.fileName ?? "pets.txt";
  return {
    userId: overrides.userId ?? "user-1",
    fileName,
    mimeType: "text/plain",
    data: Buffer.from(overrides.text ?? `${"The cat sleeps all day. The dog barks at the cat. ".repeat(10)}(${fileName})`),
  };
};

function rowCount(table: string) {
  return (stores.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  embeddings = new KeywordEmbeddings();
});

describe("IngestDocumentUseCase", () => {
  it("stores the file, the document and its embedded chunks", async () => {
    const result = await createUseCase().execute(upload());

    expect(result.chunksCount).toBeGreaterThan(1);
    expect(files.files.size).toBe(1);
    expect(rowCount("documents")).toBe(1);
    expect(rowCount("document_chunks")).toBe(result.chunksCount);

    const document = await stores.documents.findById("user-1", result.documentId);
    expect(document).toMatchObject({ fileName: "pets.txt", userId: "user-1" });
    expect([...files.files.keys()]).toEqual([document?.storedName]);
  });

  it("records the embedding model with every chunk", async () => {
    embeddings = new KeywordEmbeddings(["cat", "dog", "tax", "space"], "embed-v9");
    await createUseCase().execute(upload());

    const models = stores.db.prepare("SELECT DISTINCT embedding_model AS m FROM document_chunks").all();
    expect(models).toEqual([{ m: "embed-v9" }]);
  });

  it("rejects unsupported file types before doing any work", async () => {
    await expect(createUseCase().execute(upload({ fileName: "virus.exe" }))).rejects.toThrow(ValidationError);

    expect(embeddings.documentCalls).toHaveLength(0);
    expect(files.files.size).toBe(0);
  });

  it("rejects oversized uploads before parsing or embedding", async () => {
    const tooBig = upload({ text: "x".repeat(options.maxUploadBytes + 1) });

    await expect(createUseCase().execute(tooBig)).rejects.toThrow(/too large/);
    expect(embeddings.documentCalls).toHaveLength(0);
    expect(files.files.size).toBe(0);
  });

  it("rejects empty and text-less files", async () => {
    await expect(createUseCase().execute(upload({ text: "" }))).rejects.toThrow(/empty/);
    await expect(createUseCase().execute(upload({ text: "  \n \n  " }))).rejects.toThrow(/Could not extract text/);
    expect(rowCount("documents")).toBe(0);
  });

  it("leaves nothing behind when embedding fails (no file, no rows)", async () => {
    embeddings.failWith = new Error("provider down");

    await expect(createUseCase().execute(upload())).rejects.toThrow("provider down");

    expect(files.files.size).toBe(0);
    expect(rowCount("documents")).toBe(0);
    expect(rowCount("document_chunks")).toBe(0);
  });

  it("rejects a provider that returns the wrong number of vectors, without saving anything", async () => {
    embeddings.documentVectorsOverride = [[1, 0, 0, 0]]; // fewer vectors than chunks

    await expect(createUseCase().execute(upload())).rejects.toThrow(/temporarily unavailable/);

    expect(files.files.size).toBe(0);
    expect(rowCount("documents")).toBe(0);
  });

  it("rejects non-finite vectors", async () => {
    embeddings.documentVectorsOverride = [[Number.NaN, 0, 0, 0]];

    await expect(createUseCase().execute(upload({ text: "short text about a cat" }))).rejects.toThrow(
      /temporarily unavailable/,
    );
    expect(files.files.size).toBe(0);
  });

  it("removes the stored file when persisting fails (compensation)", async () => {
    const failingRepository = {
      getUsage: async () => ({ documentCount: 0, totalBytes: 0 }),
      findByContentHash: async () => null,
      findUnhashedBySize: async () => [],
      saveWithChunks: async () => {
        throw new Error("database is locked");
      },
    } as unknown as DocumentRepository;

    await expect(createUseCase(failingRepository).execute(upload())).rejects.toThrow("database is locked");

    expect(files.files.size).toBe(0);
    expect(rowCount("documents")).toBe(0);
  });

  it("still reports the original persistence error if file cleanup also fails", async () => {
    files.failOnDelete = true;
    const failingRepository = {
      getUsage: async () => ({ documentCount: 0, totalBytes: 0 }),
      findByContentHash: async () => null,
      findUnhashedBySize: async () => [],
      saveWithChunks: async () => {
        throw new Error("database is locked");
      },
    } as unknown as DocumentRepository;

    await expect(createUseCase(failingRepository).execute(upload())).rejects.toThrow("database is locked");
  });

  it("does not write database records when the file cannot be saved", async () => {
    files.failOnSave = true;

    await expect(createUseCase().execute(upload())).rejects.toThrow("disk full");

    expect(rowCount("documents")).toBe(0);
    expect(rowCount("document_chunks")).toBe(0);
  });

  it("keeps documents of different users separate", async () => {
    await createUseCase().execute(upload({ userId: "user-1" }));
    await createUseCase().execute(upload({ userId: "user-2" }));

    expect(await stores.documents.listByUser("user-1")).toHaveLength(1);
    expect(await stores.documents.listByUser("user-2")).toHaveLength(1);
  });
});

describe("IngestDocumentUseCase per-user limits", () => {
  it("rejects an upload beyond the document limit, before extracting or embedding anything", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 2 });
    await useCase.execute(upload({ fileName: "one.txt" }));
    await useCase.execute(upload({ fileName: "two.txt" }));
    embeddings.documentCalls.length = 0;

    await expect(useCase.execute(upload({ fileName: "three.txt" }))).rejects.toThrow(/at most 2 documents/);

    expect(embeddings.documentCalls).toHaveLength(0);
    expect(files.files.size).toBe(2);
    expect(rowCount("documents")).toBe(2);
  });

  it("counts documents per user: another user's uploads do not use up my quota", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 1 });
    await useCase.execute(upload({ userId: "user-1" }));

    await expect(useCase.execute(upload({ userId: "user-2" }))).resolves.toMatchObject({ chunksCount: expect.any(Number) });
    await expect(useCase.execute(upload({ userId: "user-1", fileName: "second.txt" }))).rejects.toThrow(ValidationError);
  });

  it("rejects an upload that would push the user's stored bytes over the storage limit", async () => {
    const text = (n: number) => `${"x".repeat(299)}${n}`; // 300 bytes each, all different content
    const useCase = createUseCase(stores.documents, { maxStorageBytesPerUser: 700 });
    await useCase.execute(upload({ text: text(1) }));
    await useCase.execute(upload({ text: text(2) }));
    embeddings.documentCalls.length = 0;

    await expect(useCase.execute(upload({ text: text(3) }))).rejects.toThrow(/storage limit/);

    expect(embeddings.documentCalls).toHaveLength(0);
    expect(rowCount("documents")).toBe(2);
  });

  it("deleting a document frees its quota", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 1 });
    const { documentId } = await useCase.execute(upload());
    await stores.documents.delete("user-1", documentId);

    await expect(useCase.execute(upload())).resolves.toBeDefined();
  });

  it("rejects a document that splits into too many chunks before paying for embeddings", async () => {
    const useCase = createUseCase(stores.documents, { maxChunksPerDocument: 2 });

    await expect(useCase.execute(upload({ text: "word ".repeat(150) }))).rejects.toThrow(/too large to index|chunks/);

    expect(embeddings.documentCalls).toHaveLength(0);
    expect(files.files.size).toBe(0);
    expect(rowCount("documents")).toBe(0);
  });

  it("serializes simultaneous uploads of one user so the limit cannot be raced", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 1 });

    const results = await Promise.allSettled([
      useCase.execute(upload({ fileName: "a.txt" })),
      useCase.execute(upload({ fileName: "b.txt" })),
      useCase.execute(upload({ fileName: "c.txt" })),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(2);
    expect(rowCount("documents")).toBe(1);
  });

  it("does not make different users wait for each other", async () => {
    const useCase = createUseCase(stores.documents, { maxDocumentsPerUser: 1 });

    const results = await Promise.allSettled([
      useCase.execute(upload({ userId: "user-1" })),
      useCase.execute(upload({ userId: "user-2" })),
    ]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
  });

  describe("index profile and provenance", () => {
    it("records the recipe the document was indexed with", async () => {
      const result = await createUseCase().execute(upload());

      const document = await stores.documents.findById("user-1", result.documentId);
      expect(document?.indexProfile).toEqual(
        buildIndexProfile({
          fileName: "pets.txt",
          embeddingModel: "test-model",
          embeddingDimension: 4,
          chunkSize: options.chunkSize,
          chunkOverlap: options.chunkOverlap,
        }),
      );
    });

    it("stores real page ranges for a paged PDF and none for text documents", async () => {
      const pages = ["Cats sleep. ".repeat(28), "Dogs bark. ".repeat(28), "Tax forms. ".repeat(28)];
      const pdf = await createUseCase().execute({
        userId: "user-1",
        fileName: "manual.pdf",
        mimeType: "application/pdf",
        data: Buffer.from(pages.join(PAGE_BREAK)),
      });
      const text = await createUseCase().execute(upload({ fileName: "plain.txt" }));

      const rows = (documentId: string) =>
        stores.db
          .prepare("SELECT content, page_start AS s, page_end AS e FROM document_chunks WHERE document_id = ? ORDER BY chunk_index")
          .all(documentId) as Array<{ content: string; s: number | null; e: number | null }>;

      const pdfRows = rows(pdf.documentId);
      expect(pdfRows.length).toBeGreaterThan(2);
      expect(pdfRows.every((row) => row.s !== null && row.e !== null && row.e >= row.s)).toBe(true);
      expect(pdfRows[0].s).toBe(1);
      expect(pdfRows[pdfRows.length - 1].e).toBe(3);
      // A chunk that only contains dog text can only come from page 2.
      const dogOnly = pdfRows.find((row) => row.content.includes("Dogs bark") && !row.content.includes("Cats sleep") && !row.content.includes("Tax forms"));
      expect(dogOnly).toMatchObject({ s: 2, e: 2 });
      expect(rows(text.documentId).every((row) => row.s === null && row.e === null)).toBe(true);
    });
  });
});

describe("Markdown section provenance", () => {
  const withOptions = { chunkSize: 80, chunkOverlap: 10 };

  async function ingestMarkdown(text: string, fileName = "api.md") {
    const result = await createUseCase(stores.documents, withOptions).execute(upload({ fileName, text }));
    const ids = (stores.db.prepare("SELECT id FROM document_chunks WHERE document_id = ? ORDER BY chunk_index").all(result.documentId) as Array<{ id: string }>).map(
      (row) => row.id,
    );
    const chunks = await stores.vectorStore.getChunks("user-1", ids);
    return ids.map((id) => chunks.find((chunk) => chunk.chunkId === id)!);
  }

  it("a single top-level heading labels the chunks below it", async () => {
    const chunks = await ingestMarkdown("# Authentication\n\nTokens identify the caller.");

    expect(chunks).toHaveLength(1);
    expect(chunks[0].sectionPath).toEqual(["Authentication"]);
    expect(chunks[0].chunkIndex).toBe(0);
  });

  it("nested headings give the whole hierarchy", async () => {
    const chunks = await ingestMarkdown(
      "# Authentication\n\nIntro to authentication and how callers prove who they are.\n\n## Refresh tokens\n\nRefresh tokens last for thirty days and can be rotated at any time.",
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.sectionPath)).toContainEqual(["Authentication"]);
    expect(chunks.map((chunk) => chunk.sectionPath)).toContainEqual(["Authentication", "Refresh tokens"]);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });

  it("text before the first heading has no section: the chunk number is shown instead of an invented one", async () => {
    const chunks = await ingestMarkdown("Preamble that comes before any heading at all, in plain words.\n\n# First\n\nBody of the first section is here.");

    expect(chunks[0].content).toContain("Preamble");
    expect(chunks[0]).not.toHaveProperty("sectionPath");
    expect(chunks.some((chunk) => chunk.sectionPath?.[0] === "First")).toBe(true);
  });

  it("a very long section is split by the normal rules and every part keeps the section", async () => {
    const chunks = await ingestMarkdown(`# Long section\n\n${"The quick brown fox jumps over the lazy dog. ".repeat(20)}`);

    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((chunk) => chunk.content.length <= withOptions.chunkSize)).toBe(true);
    expect(chunks.every((chunk) => chunk.sectionPath?.join(">") === "Long section")).toBe(true);
  });

  it("headings with the same name under different parents stay distinct", async () => {
    const chunks = await ingestMarkdown(
      "# One\n\n## Setup\n\nInstall the first thing and then configure it carefully.\n\n# Two\n\n## Setup\n\nInstall the second thing and then configure it differently.",
    );
    const paths = chunks.map((chunk) => chunk.sectionPath?.join(" > "));

    expect(paths).toContain("One > Setup");
    expect(paths).toContain("Two > Setup");
  });

  it("keeps the heading text searchable: headings are part of the chunk content", async () => {
    const chunks = await ingestMarkdown("# Authentication\n\nShort body.");

    expect(chunks[0].content).toContain("# Authentication");
  });

  it("ignores heading-like lines in code blocks", async () => {
    const chunks = await ingestMarkdown("# Real\n\n```sh\n# not a heading\nls\n```");

    expect(chunks.every((chunk) => chunk.sectionPath?.[0] === "Real")).toBe(true);
    expect(chunks.some((chunk) => chunk.sectionPath?.includes("not a heading"))).toBe(false);
  });

  it("does not give plain text files a section path, even if they contain lines that start with #", async () => {
    const chunks = await ingestMarkdown("# looks like a heading\n\nbut this is notes.txt", "notes.txt");

    expect(chunks.every((chunk) => chunk.sectionPath === undefined)).toBe(true);
  });

  it("records a different extractor version for Markdown, so documents indexed before section paths are reported as stale", async () => {
    const markdown = await createUseCase().execute(upload({ fileName: "a.md", text: "# A\n\nbody" }));
    const text = await createUseCase().execute(upload({ fileName: "a.txt", text: "# A\n\nbody of the text file" }));

    const profile = async (id: string) => (await stores.documents.findById("user-1", id))?.indexProfile?.extractorVersion;
    expect(await profile(markdown.documentId)).toBe("markdown-sections-v2");
    expect(await profile(text.documentId)).toBe("text-v1");
  });
});

describe("page provenance: physical pages and optional printed labels", () => {
  const pagedExtractor = (labels: boolean) => ({
    async extract() {
      return {
        text: "",
        pages: [
          { pageNumber: 5, text: "The cat feeder resets itself after a power cut.", ...(labels ? { label: "iii" } : {}) },
          { pageNumber: 6, text: "The dog bowl is dishwasher safe.", ...(labels ? { label: "iv" } : {}) },
        ],
      };
    },
  });

  async function ingestPaged(labels: boolean) {
    const result = await new IngestDocumentUseCase({
      documents: stores.documents,
      files,
      extractor: pagedExtractor(labels),
      embeddings,
      options: { ...options, chunkSize: 60, chunkOverlap: 0 },
    }).execute({ userId: "user-1", fileName: "spec.pdf", mimeType: "application/pdf", data: Buffer.from("x") });
    const ids = (stores.db.prepare("SELECT id FROM document_chunks WHERE document_id = ? ORDER BY chunk_index").all(result.documentId) as Array<{ id: string }>).map((row) => row.id);
    return stores.vectorStore.getChunks("user-1", ids);
  }

  it("keeps the physical page of every chunk and stores printed labels next to it when the extractor supplies them", async () => {
    const chunks = await ingestPaged(true);

    expect(chunks.map(({ pageStart, pageEnd, pageLabelStart, pageLabelEnd }) => ({ pageStart, pageEnd, pageLabelStart, pageLabelEnd }))).toEqual([
      { pageStart: 5, pageEnd: 5, pageLabelStart: "iii", pageLabelEnd: "iii" },
      { pageStart: 6, pageEnd: 6, pageLabelStart: "iv", pageLabelEnd: "iv" },
    ]);
  });

  it("falls back to the physical pages alone when no labels are available", async () => {
    const chunks = await ingestPaged(false);

    expect(chunks.map((chunk) => [chunk.pageStart, chunk.pageEnd])).toEqual([
      [5, 5],
      [6, 6],
    ]);
    expect(chunks.every((chunk) => chunk.pageLabelStart === undefined && chunk.pageLabelEnd === undefined)).toBe(true);
  });
});
