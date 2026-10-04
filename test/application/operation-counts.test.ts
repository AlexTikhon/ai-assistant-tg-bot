import { beforeEach, describe, expect, it } from "vitest";
import { HybridRetriever } from "../../src/application/hybrid-retriever.js";
import { prepareIndex } from "../../src/application/prepare-index.js";
import { AnswerQuestionUseCase } from "../../src/application/use-cases/answer-question.use-case.js";
import { SummarizeDocumentUseCase } from "../../src/application/use-cases/summarize-document.use-case.js";
import { createOpenAIEmbeddings, OpenAIEmbeddingsProvider } from "../../src/infrastructure/openai/openai-embeddings.js";
import { createTestStores, FakeChatModel, KeywordEmbeddings, makeChunk, makeDocument, Utf8Extractor } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let embeddings: KeywordEmbeddings;

type Entry = { fields: Record<string, unknown>; message: string };
function createLog() {
  const entries: Entry[] = [];
  const record = (fields: Record<string, unknown>, message: string) => void entries.push({ fields, message });
  return { entries, info: record, warn: record };
}

beforeEach(async () => {
  stores = createTestStores();
  embeddings = new KeywordEmbeddings();
  await stores.documents.saveWithChunks(makeDocument({ id: "doc-1" }), [
    makeChunk({ documentId: "doc-1", chunkIndex: 0, content: "the cat sleeps on the sofa", embedding: await embeddings.embedQuery("the cat sleeps on the sofa") }),
  ]);
  embeddings.queryCalls.length = 0;
});

describe("operation counts in logs: how many provider calls did this cost?", () => {
  it("an answered question logs one embedding call and one chat call", async () => {
    const log = createLog();
    const useCase = new AnswerQuestionUseCase({
      retriever: new HybridRetriever({ embeddings, vectorStore: stores.vectorStore, options: { topK: 3, minScore: 0.2, semanticLimit: 10, lexicalLimit: 10, contextMaxChars: 10_000 } }),
      chatModel: new FakeChatModel("The cat sleeps. [1]"),
      log,
    });

    await useCase.execute({ userId: "user-1", question: "cat" });

    expect(log.entries.find((entry) => entry.message === "Question answered")?.fields).toMatchObject({ calls: { embedding: 1, chat: 1 } });
  });

  it("an abstention logs one embedding call and no chat call", async () => {
    const log = createLog();
    const useCase = new AnswerQuestionUseCase({
      retriever: new HybridRetriever({
        embeddings,
        vectorStore: stores.vectorStore,
        options: { topK: 3, minScore: 0.2, semanticLimit: 10, lexicalLimit: 10, contextMaxChars: 10_000, confidence: { minSemanticScore: 0.99, minTermCoverage: 0.99, requireKnownIdentifiers: true }, confidenceMode: "enforce" },
      }),
      chatModel: new FakeChatModel(),
      log,
    });

    await useCase.execute({ userId: "user-1", question: "cat tax dog space" });

    expect(log.entries.find((entry) => entry.message === "Question not answered: insufficient evidence")?.fields).toMatchObject({ calls: { embedding: 1, chat: 0 } });
  });

  it("a summary logs how many generation calls it needed (a long document is map-reduced)", async () => {
    const log = createLog();
    const chunks = Array.from({ length: 6 }, (_, index) => makeChunk({ id: `s${index}`, documentId: "long", chunkIndex: index, content: `Section ${index}. `.repeat(40) }));
    await stores.documents.saveWithChunks(makeDocument({ id: "long" }), chunks);
    const chatModel = new FakeChatModel("partial summary");
    const useCase = new SummarizeDocumentUseCase({ documents: stores.documents, vectorStore: stores.vectorStore, chatModel, options: { directMaxChars: 300, groupMaxChars: 300 }, log });

    await useCase.execute("user-1", "long");

    const entry = log.entries.find((item) => item.message === "Summary generated");
    expect(entry?.fields.generationCalls).toBe(chatModel.calls.length);
    expect(chatModel.calls.length).toBeGreaterThan(1);
  });
});

describe("ingestion counts", () => {
  it("prepareIndex reports the number of chunks and of embedding requests", async () => {
    const batched = new KeywordEmbeddings();
    Object.assign(batched, { batchSize: 3 });

    const prepared = await prepareIndex({ extractor: new Utf8Extractor(), embeddings: batched }, { fileName: "a.txt", mimeType: "text/plain", data: Buffer.from("The cat sleeps all day. ".repeat(30)) }, { chunkSize: 100, chunkOverlap: 10, maxChunksPerDocument: 100 });

    expect(prepared.chunks.length).toBeGreaterThan(6);
    expect(prepared.embeddingRequests).toBe(Math.ceil(prepared.chunks.length / 3));
  });

  it("a provider that does not batch counts as one request", async () => {
    const prepared = await prepareIndex({ extractor: new Utf8Extractor(), embeddings }, { fileName: "a.txt", mimeType: "text/plain", data: Buffer.from("The cat sleeps all day. ".repeat(30)) }, { chunkSize: 100, chunkOverlap: 10, maxChunksPerDocument: 100 });

    expect(prepared.embeddingRequests).toBe(1);
  });
});

describe("the OpenAI embeddings adapter's batch size", () => {
  it("is derived from the chunk size, so a request cannot exceed the provider's token cap", () => {
    expect(createOpenAIEmbeddings({ apiKey: "sk-test-key-123456789012345", model: "m", timeoutMs: 1000, chunkSize: 1000 }).batchSize).toBe(250);
    expect(createOpenAIEmbeddings({ apiKey: "sk-test-key-123456789012345", model: "m", timeoutMs: 1000, chunkSize: 4000 }).batchSize).toBe(62);
  });

  it("exposes the size it was given, and a wrapper without one reports none", () => {
    expect(new OpenAIEmbeddingsProvider("m", { embedDocuments: async () => [], embedQuery: async () => [] }, 17).batchSize).toBe(17);
    expect(new OpenAIEmbeddingsProvider("m", { embedDocuments: async () => [], embedQuery: async () => [] }).batchSize).toBeUndefined();
  });
});
