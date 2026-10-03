import type { ChatMessage, ChatModel } from "../../src/application/ports/chat-model.js";
import type { EmbeddingsProvider } from "../../src/application/ports/embeddings-provider.js";
import type { FileStorage } from "../../src/application/ports/file-storage.js";
import type { DocumentTextExtractor, ExtractionInput } from "../../src/application/ports/text-extractor.js";
import type { ChunkRecord, DocumentRecord } from "../../src/core/document.js";
import { openDatabase } from "../../src/infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "../../src/infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteVectorStore } from "../../src/infrastructure/sqlite/sqlite-vector-store.js";

/** Fresh in-memory SQLite database with the real schema, repository and vector store. */
export function createTestStores() {
  const db = openDatabase(":memory:", { legacyEmbeddingModel: "test-model" });
  return { db, documents: new SqliteDocumentRepository(db), vectorStore: new SqliteVectorStore(db) };
}

/**
 * Deterministic "embeddings": one dimension per keyword, valued by how often the keyword occurs.
 * Texts about the same topic end up close together, which is all retrieval tests need.
 */
export class KeywordEmbeddings implements EmbeddingsProvider {
  documentCalls: string[][] = [];
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
  private counter = 0;

  async save(fileName: string, data: Buffer) {
    if (this.failOnSave) throw new Error("disk full");
    const storedName = `${(this.counter += 1)}-${fileName}`;
    this.files.set(storedName, data);
    return storedName;
  }

  async delete(storedName: string) {
    if (this.failOnDelete) throw new Error("permission denied");
    this.files.delete(storedName);
  }
}

/** Treats the uploaded bytes as UTF-8 text. */
export class Utf8Extractor implements DocumentTextExtractor {
  async extract(input: ExtractionInput) {
    return input.data.toString("utf-8");
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
