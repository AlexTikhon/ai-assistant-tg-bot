import { beforeEach, describe, expect, it } from "vitest";
import { HybridRetriever } from "../../src/application/hybrid-retriever.js";
import { AnswerQuestionUseCase } from "../../src/application/use-cases/answer-question.use-case.js";
import { IngestDocumentUseCase } from "../../src/application/use-cases/ingest-document.use-case.js";
import { answered, createTestStores, FakeChatModel, InMemoryFileStorage, KeywordEmbeddings, Utf8Extractor } from "../support/fakes.js";

/**
 * What normal question answering does with documents whose index is stale or damaged. The policy:
 *
 *   embedding-stale  keyword search keeps working; semantic search never compares vectors of another model
 *   chunking/extractor-stale  fully searchable: the index is consistent, just not laid out as configured
 *   corrupt vectors  skipped by semantic search (warned about), their text is still found by keyword search
 *   missing original  nothing changes for questions: the chunks are all they use
 *   and none of it ever spends an API call to "repair" anything while answering
 */
let stores: ReturnType<typeof createTestStores>;
let files: InMemoryFileStorage;
let embeddings: KeywordEmbeddings;

const options = { maxUploadBytes: 100_000, chunkSize: 200, chunkOverlap: 20, maxDocumentsPerUser: 10, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 100 };

async function ingest(fileName: string, text: string, provider = embeddings) {
  const result = await new IngestDocumentUseCase({ documents: stores.documents, files, extractor: new Utf8Extractor(), embeddings: provider, options }).execute({
    userId: "u1",
    fileName,
    mimeType: "text/plain",
    data: Buffer.from(text),
  });
  return result.documentId;
}

const retriever = () =>
  new HybridRetriever({ embeddings, vectorStore: stores.vectorStore, options: { topK: 5, minScore: 0.2, semanticLimit: 10, lexicalLimit: 10, contextMaxChars: 10_000 } });
const search = (question: string) => retriever().retrieve({ userId: "u1", question });
const documentsOf = (result: Awaited<ReturnType<typeof search>>) => new Set(result.chunks.map((chunk) => chunk.fileName));

beforeEach(() => {
  stores = createTestStores();
  files = new InMemoryFileStorage();
  embeddings = new KeywordEmbeddings();
});

describe("stale embeddings", () => {
  it("are never compared with the query vector, but the document is still found by keyword search", async () => {
    const stale = await ingest("old.txt", "The kitchen cat sleeps on the sofa all afternoon. ".repeat(4), new KeywordEmbeddings(["cat", "dog", "tax", "space"], "older-model"));
    await ingest("current.txt", "The kitchen cat purrs. ".repeat(4));
    embeddings.queryCalls.length = 0;

    const result = await search("cat");

    expect(result.candidates.filter((chunk) => chunk.documentId === stale).every((chunk) => chunk.ranking.semanticRank === undefined)).toBe(true);
    expect(result.candidates.filter((chunk) => chunk.documentId === stale).every((chunk) => chunk.ranking.lexicalRank !== undefined)).toBe(true);
    expect(documentsOf(result)).toEqual(new Set(["old.txt", "current.txt"]));
  });

  it("a document that only has stale vectors answers purely on keywords, never on mixed-up similarity scores", async () => {
    await ingest("old.txt", "ECONNRESET happens when the proxy drops the connection. ".repeat(3), new KeywordEmbeddings(["cat", "dog", "tax", "space"], "older-model"));

    const result = await search("ECONNRESET");

    expect(result.signals.semanticCount).toBe(0);
    expect(result.signals.lexicalCount).toBeGreaterThan(0);
    expect(result.chunks.length).toBeGreaterThan(0);
  });
});

describe("other staleness and damage", () => {
  it("a different chunk layout does not affect search at all", async () => {
    await ingest("a.txt", "The cat sleeps on the sofa. ".repeat(10));
    stores.db.prepare("UPDATE documents SET index_profile = json_set(index_profile, '$.chunkSize', 999, '$.chunkingVersion', 0)").run();

    expect((await search("cat")).chunks.length).toBeGreaterThan(0);
  });

  it("an older extractor does not affect search either", async () => {
    await ingest("a.md", "# Pets\n\nThe cat sleeps on the sofa. ".repeat(5));
    stores.db.prepare("UPDATE documents SET index_profile = json_set(index_profile, '$.extractorVersion', 'text-v1')").run();

    expect((await search("cat")).chunks.length).toBeGreaterThan(0);
  });

  it("a corrupt vector is skipped by semantic search, its text is still found by keyword, and nothing throws", async () => {
    const id = await ingest("a.txt", "The cat sleeps on the sofa. ".repeat(10));
    stores.db.prepare("UPDATE document_chunks SET embedding = x'0102' WHERE document_id = ? AND chunk_index = 0").run(id);

    const result = await search("cat");

    const first = result.candidates.find((chunk) => chunk.chunkIndex === 0);
    expect(first?.ranking.semanticRank).toBeUndefined();
    expect(first?.ranking.lexicalRank).toBeDefined();
  });

  it("a document whose original file is gone is searched exactly as before", async () => {
    const id = await ingest("a.txt", "The cat sleeps on the sofa. ".repeat(10));
    const before = (await search("cat")).chunks.map((chunk) => chunk.chunkId);
    files.files.delete((await stores.documents.findById("u1", id))!.storedName);

    expect((await search("cat")).chunks.map((chunk) => chunk.chunkId)).toEqual(before);
  });
});

describe("answering never repairs anything by itself", () => {
  it("makes no embedding call for documents (only the one query embedding) and no write, whatever the state of the index", async () => {
    await ingest("old.txt", "The cat sleeps on the sofa. ".repeat(6), new KeywordEmbeddings(["cat", "dog", "tax", "space"], "older-model"));
    const corrupt = await ingest("bad.txt", "The cat chases the dog. ".repeat(6));
    stores.db.prepare("UPDATE document_chunks SET embedding = x'0102' WHERE document_id = ?").run(corrupt);
    const snapshot = () => JSON.stringify(stores.db.prepare("SELECT id, embedding, embedding_model FROM document_chunks ORDER BY id").all());
    const before = snapshot();
    embeddings.documentCalls.length = 0;
    embeddings.queryCalls.length = 0;

    const useCase = new AnswerQuestionUseCase({ retriever: retriever(), chatModel: new FakeChatModel("The cat sleeps. [1]"), log: { info: () => undefined, warn: () => undefined } });
    const result = answered(await useCase.execute({ userId: "u1", question: "where does the cat sleep" }));

    expect(result.sources.length).toBeGreaterThan(0);
    expect(embeddings.documentCalls).toHaveLength(0);
    expect(embeddings.queryCalls).toHaveLength(1);
    expect(snapshot()).toBe(before);
  });
});
