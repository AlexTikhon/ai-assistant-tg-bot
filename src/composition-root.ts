import fs from "node:fs";
import type { Telegraf } from "telegraf";
import { AnswerQuestionUseCase } from "./application/use-cases/answer-question.use-case.js";
import { DeleteDocumentUseCase } from "./application/use-cases/delete-document.use-case.js";
import { IngestDocumentUseCase } from "./application/use-cases/ingest-document.use-case.js";
import { ListDocumentsUseCase } from "./application/use-cases/list-documents.use-case.js";
import { ReindexDocumentUseCase } from "./application/use-cases/reindex-document.use-case.js";
import { SummarizeDocumentUseCase } from "./application/use-cases/summarize-document.use-case.js";
import type { AppConfig } from "./config/config.js";
import { FileTextExtractor } from "./infrastructure/documents/file-text-extractor.js";
import { createOpenAIChatModel } from "./infrastructure/openai/openai-chat-model.js";
import { createOpenAIEmbeddings } from "./infrastructure/openai/openai-embeddings.js";
import { OpenAISpeechToText } from "./infrastructure/openai/openai-speech-to-text.js";
import { openDatabase } from "./infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "./infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteVectorStore } from "./infrastructure/sqlite/sqlite-vector-store.js";
import { LocalFileStorage } from "./infrastructure/storage/local-file-storage.js";
import { createBot } from "./telegram/bot.js";

export type Application = {
  bot: Telegraf;
  /** Not wired to Telegram; exposed for scripts that need to re-embed documents after a model change. */
  reindexDocument: ReindexDocumentUseCase;
  /** Releases resources held by the infrastructure (the SQLite connection). */
  close(): void;
};

/**
 * The only place that knows concrete implementations. It builds every adapter exactly once,
 * injects them into the use cases, and hands the use cases to the Telegram layer.
 */
export function createApplication(config: AppConfig): Application {
  fs.mkdirSync(config.storage.dataDir, { recursive: true });

  // Infrastructure
  const db = openDatabase(config.storage.sqlitePath, { legacyEmbeddingModel: config.openai.embeddingsModel });

  try {
    const documents = new SqliteDocumentRepository(db);
    const vectorStore = new SqliteVectorStore(db);
    const files = new LocalFileStorage(config.storage.filesDir);
    const extractor = new FileTextExtractor();
    const embeddings = createOpenAIEmbeddings({
      apiKey: config.openai.apiKey,
      model: config.openai.embeddingsModel,
      timeoutMs: config.openai.requestTimeoutMs,
    });
    const chatModel = createOpenAIChatModel({
      apiKey: config.openai.apiKey,
      model: config.openai.chatModel,
      timeoutMs: config.openai.requestTimeoutMs,
    });
    const speechToText = new OpenAISpeechToText({
      apiKey: config.openai.apiKey,
      model: config.openai.transcribeModel,
      timeoutMs: config.openai.requestTimeoutMs,
    });

    // Use cases
    const ingestDocument = new IngestDocumentUseCase({ documents, files, extractor, embeddings, options: config.ingestion });
    const answerQuestion = new AnswerQuestionUseCase({
      embeddings,
      vectorStore,
      chatModel,
      options: { ...config.retrieval, logQuestions: config.logQuestions },
    });
    const listDocuments = new ListDocumentsUseCase({ documents });
    const summarizeDocument = new SummarizeDocumentUseCase({ documents, vectorStore, chatModel });
    const deleteDocument = new DeleteDocumentUseCase({ documents, vectorStore, files });
    const reindexDocument = new ReindexDocumentUseCase({ documents, vectorStore, embeddings });

    // Delivery
    const bot = createBot(config.telegram.botToken, config.telegram.handlerTimeoutMs, {
      ingestDocument,
      answerQuestion,
      listDocuments,
      summarizeDocument,
      deleteDocument,
      speechToText,
      downloadLimits: { maxBytes: config.ingestion.maxUploadBytes, timeoutMs: config.ingestion.downloadTimeoutMs },
    });

    return { bot, reindexDocument, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
