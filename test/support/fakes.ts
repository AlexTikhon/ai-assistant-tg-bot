import type { ChatMessage, ChatModel } from "../../src/application/ports/chat-model.js";
import type { EmbeddingsProvider } from "../../src/application/ports/embeddings-provider.js";
import type { FileStorage } from "../../src/application/ports/file-storage.js";
import type { DocumentTextExtractor, ExtractionInput } from "../../src/application/ports/text-extractor.js";
import type { AnswerQuestionResult } from "../../src/application/use-cases/answer-question.use-case.js";
import type { ExtractedDocument } from "../../src/core/pages.js";
import type { ChunkRecord, DocumentRecord } from "../../src/core/document.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { SqliteIndexMaintenance } from "../../src/infrastructure/sqlite/sqlite-index-maintenance.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteVectorStore } from "../../src/infrastructure/sqlite/sqlite-vector-store.js";

/** Fresh in-memory SQLite database with the real schema, repository and vector store. */
export function createTestStores() {
  const db = openDatabase(":memory:", { legacyEmbeddingModel: "test-model" });
  return {
    db,
    documents: new SqliteDocumentRepository(db),
    vectorStore: new SqliteVectorStore(db),
    maintenance: new SqliteIndexMaintenance(db),
  };
}

/**
 * Deterministic "embeddings": one dimension per keyword, valued by how often the keyword occurs.
 * Texts about the same topic end up close together, which is all retrieval tests need.
 */
export class KeywordEmbeddings implements EmbeddingsProvider {
  documentCalls: string[][] = [];
  queryCalls: string[] = [];
  failWith?: Error;
  /** Overrides the vectors returned for documents (e.g. to simulate a misbehaving provider). */
  documentVectorsOverride?: number[][];

  constructor(
    readonly keywords: string[] = ["cat", "dog", "tax", "space"],
    readonly model = "test-model",
  ) {}

  private embed(text: string) {
    const lower = text.toLowerCase();
    const vector = this.keywords.map((keyword) => lower.split(keyword).length - 1);
    return vector.some((value) => value > 0) ? vector : [...vector.slice(0, -1), 0.001];
  }

  async embedDocuments(texts: string[]) {
    this.documentCalls.push(texts);
    if (this.failWith) throw this.failWith;
    return this.documentVectorsOverride ?? texts.map((text) => this.embed(text));
  }

  async embedQuery(text: string) {
    this.queryCalls.push(text);
    if (this.failWith) throw this.failWith;
    return this.embed(text);
  }
}

export class FakeChatModel implements ChatModel {
  calls: ChatMessage[][] = [];

  constructor(private readonly reply: string | ((messages: ChatMessage[]) => string) = "fake answer") {}

  async complete(messages: ChatMessage[]) {
    this.calls.push(messages);
    return typeof this.reply === "function" ? this.reply(messages) : this.reply;
  }
}

export class InMemoryFileStorage implements FileStorage {
  files = new Map<string, Buffer>();
  failOnSave = false;
  failOnDelete = false;
  failOnRead = false;
  private counter = 0;

  async save(fileName: string, data: Buffer) {
    if (this.failOnSave) throw new Error("disk full");
    const storedName = `${(this.counter += 1)}-${fileName}`;
    this.files.set(storedName, data);
    return storedName;
  }

  async read(storedName: string) {
    const data = this.files.get(storedName);
    if (this.failOnRead || !data) throw new Error(`cannot read ${storedName}`);
    return data;
  }

  async delete(storedName: string) {
    if (this.failOnDelete) throw new Error("permission denied");
    this.files.delete(storedName);
  }
}

/** Separates the pages of a test "PDF" for Utf8Extractor. */
export const PAGE_BREAK = "<<page-break>>";

/**
 * Treats the uploaded bytes as UTF-8 text. A file named *.pdf that contains PAGE_BREAK markers has pages,
 * which gives tests page provenance without a real PDF parser. Anything else has no pages.
 */
export class Utf8Extractor implements DocumentTextExtractor {
  failWith?: Error;
  calls = 0;

  async extract(input: ExtractionInput): Promise<ExtractedDocument> {
    this.calls += 1;
    if (this.failWith) throw this.failWith;
    const text = input.data.toString("utf-8");
    if (!input.fileName.toLowerCase().endsWith(".pdf") || !text.includes(PAGE_BREAK)) {
      return { text };
    }
    const pages = text.split(PAGE_BREAK).map((page, index) => ({ pageNumber: index + 1, text: page }));
    return { text: pages.map((page) => page.text).join("\n\n"), pages };
  }
}

export function makeDocument(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: "doc-1",
    userId: "user-1",
    fileName: "notes.txt",
    storedName: "stored-notes.txt",
    mimeType: "text/plain",
    fileSize: 100,
    textLength: 100,
    summary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeChunk(overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    id: `chunk-${Math.random().toString(36).slice(2)}`,
    documentId: "doc-1",
    userId: "user-1",
    chunkIndex: 0,
    content: "content",
    embedding: [1, 0, 0, 0],
    embeddingModel: "test-model",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Narrows an answer-question result to the "answered" case, failing the test if the bot abstained. */
export function answered(result: AnswerQuestionResult) {
  if (result.kind !== "answered") {
    throw new Error(`Expected an answer but the bot abstained (${result.reason})`);
  }
  return result;
}
