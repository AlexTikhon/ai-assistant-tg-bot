import fs from "node:fs";
import type { Telegraf } from "telegraf";
import { checkIndexCompatibility } from "./application/check-index-compatibility.js";
import { HybridRetriever } from "./application/hybrid-retriever.js";
import { AnswerQuestionUseCase } from "./application/use-cases/answer-question.use-case.js";
import { DeleteDocumentUseCase } from "./application/use-cases/delete-document.use-case.js";
import { IngestDocumentUseCase } from "./application/use-cases/ingest-document.use-case.js";
import { ListDocumentsUseCase } from "./application/use-cases/list-documents.use-case.js";
import { ReindexDocumentUseCase } from "./application/use-cases/reindex-document.use-case.js";
import { RunReindexUseCase } from "./application/use-cases/run-reindex.use-case.js";
import { SummarizeDocumentUseCase } from "./application/use-cases/summarize-document.use-case.js";
import type { AppConfig } from "./config/config.js";
import { FileTextExtractor } from "./infrastructure/documents/file-text-extractor.js";
import { createOpenAIChatModel } from "./infrastructure/openai/openai-chat-model.js";
import { createOpenAIEmbeddings } from "./infrastructure/openai/openai-embeddings.js";
import { OpenAISpeechToText } from "./infrastructure/openai/openai-speech-to-text.js";
import { openDatabase } from "./infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "./infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteIndexMaintenance } from "./infrastructure/sqlite/sqlite-index-maintenance.js";
import { SqliteVectorStore } from "./infrastructure/sqlite/sqlite-vector-store.js";
import { LocalFileStorage } from "./infrastructure/storage/local-file-storage.js";
import { logger } from "./shared/logger.js";
import { createBot } from "./telegram/bot.js";

export type Application = {
  bot: Telegraf;
  /** Logs a warning if stored vectors do not match the configured embeddings model. Reads the DB only. */
  checkIndex(): Promise<void>;
  /** Releases resources held by the infrastructure (the SQLite connection). */
  close(): void;
};

export type ReindexTool = {
  reindex: RunReindexUseCase;
  close(): void;
};

/** The adapters shared by the bot and the maintenance CLI. */
function createStorage(config: AppConfig) {
  fs.mkdirSync(config.storage.dataDir, { recursive: true });

  const db = openDatabase(config.storage.sqlitePath, { legacyEmbeddingModel: config.openai.embeddingsModel });
  try {
    return {
      db,
      documents: new SqliteDocumentRepository(db),
      vectorStore: new SqliteVectorStore(db),
      maintenance: new SqliteIndexMaintenance(db),
      embeddings: createOpenAIEmbeddings({
        apiKey: config.openai.apiKey,
        model: config.openai.embeddingsModel,
        timeoutMs: config.openai.requestTimeoutMs,
      }),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The only place that knows concrete implementations. It builds every adapter exactly once,
 * injects them into the use cases, and hands the use cases to the Telegram layer.
 */
export function createApplication(config: AppConfig): Application {
  const { db, documents, vectorStore, maintenance, embeddings } = createStorage(config);

  try {
    const files = new LocalFileStorage(config.storage.filesDir);
    const extractor = new FileTextExtractor();
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
    const ingestDocument = new IngestDocumentUseCase({
      documents,
      files,
      extractor,
      embeddings,
      options: config.ingestion,
    });
    const answerQuestion = new AnswerQuestionUseCase({
      retriever: new HybridRetriever({ embeddings, vectorStore, options: config.retrieval }),
      chatModel,
      options: { logQuestions: config.logQuestions, ragDebug: config.ragDebug },
    });
    const listDocuments = new ListDocumentsUseCase({ documents });
    const summarizeDocument = new SummarizeDocumentUseCase({ documents, vectorStore, chatModel });
    const deleteDocument = new DeleteDocumentUseCase({ documents, vectorStore, files });

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

    return {
      bot,
      checkIndex: async () => void (await checkIndexCompatibility(maintenance, embeddings.model, logger)),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Wires the re-indexing workflow for `npm run reindex` (no Telegram involved). */
export function createReindexTool(config: AppConfig): ReindexTool {
  const { db, documents, vectorStore, maintenance, embeddings } = createStorage(config);

  return {
    reindex: new RunReindexUseCase({
      maintenance,
      embeddings,
      reindexDocument: new ReindexDocumentUseCase({ documents, vectorStore, embeddings }),
    }),
    close: () => db.close(),
  };
}
