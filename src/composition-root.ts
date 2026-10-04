import fs from "node:fs";
import type { Telegraf } from "telegraf";
import { checkIndexCompatibility } from "./application/check-index-compatibility.js";
import { HybridRetriever } from "./application/hybrid-retriever.js";
import { AnswerQuestionUseCase } from "./application/use-cases/answer-question.use-case.js";
import { DeleteDocumentUseCase } from "./application/use-cases/delete-document.use-case.js";
import { IngestDocumentUseCase } from "./application/use-cases/ingest-document.use-case.js";
import { ListDocumentsUseCase } from "./application/use-cases/list-documents.use-case.js";
import { RechunkDocumentUseCase } from "./application/use-cases/rechunk-document.use-case.js";
import { ReindexDocumentUseCase } from "./application/use-cases/reindex-document.use-case.js";
import { RunReindexUseCase } from "./application/use-cases/run-reindex.use-case.js";
import { SummarizeDocumentUseCase } from "./application/use-cases/summarize-document.use-case.js";
import type { AppConfig, ToolConfig } from "./config/config.js";
import type { EmbeddingsProvider } from "./application/ports/embeddings-provider.js";
import { FileTextExtractor } from "./infrastructure/documents/file-text-extractor.js";
import { createOpenAIChatModel } from "./infrastructure/openai/openai-chat-model.js";
import { createOpenAIEmbeddings } from "./infrastructure/openai/openai-embeddings.js";
import { OfflineEmbeddings } from "./infrastructure/openai/offline-embeddings.js";
import { OpenAISpeechToText } from "./infrastructure/openai/openai-speech-to-text.js";
import { openDatabase } from "./infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "./infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteIndexMaintenance } from "./infrastructure/sqlite/sqlite-index-maintenance.js";
import { SqliteVectorStore } from "./infrastructure/sqlite/sqlite-vector-store.js";
import { LocalFileStorage } from "./infrastructure/storage/local-file-storage.js";
import { logger } from "./shared/logger.js";
import { RateLimiter } from "./shared/rate-limiter.js";
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

/** What the adapters shared by the bot and the maintenance CLI need; no Telegram settings. */
type StorageSettings = {
  storage: { dataDir: string; sqlitePath: string };
  embeddings: EmbeddingsProvider;
  legacyEmbeddingModel: string;
};

function createStorage(settings: StorageSettings) {
  fs.mkdirSync(settings.storage.dataDir, { recursive: true });

  const db = openDatabase(settings.storage.sqlitePath, { legacyEmbeddingModel: settings.legacyEmbeddingModel });
  try {
    return {
      db,
      documents: new SqliteDocumentRepository(db),
      vectorStore: new SqliteVectorStore(db),
      maintenance: new SqliteIndexMaintenance(db),
      embeddings: settings.embeddings,
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
  const embeddings = createOpenAIEmbeddings({
    apiKey: config.openai.apiKey,
    model: config.openai.embeddingsModel,
    timeoutMs: config.openai.requestTimeoutMs,
  });
  const { db, documents, vectorStore, maintenance } = createStorage({
    storage: config.storage,
    embeddings,
    legacyEmbeddingModel: config.openai.embeddingsModel,
  });

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
      options: { ...config.ingestion, ...config.limits },
    });
    const answerQuestion = new AnswerQuestionUseCase({
      retriever: new HybridRetriever({ embeddings, vectorStore, options: config.retrieval }),
      chatModel,
      options: { logQuestions: config.logQuestions, ragDebug: config.ragDebug },
    });
    const listDocuments = new ListDocumentsUseCase({ documents });
    const summarizeDocument = new SummarizeDocumentUseCase({
      documents,
      vectorStore,
      chatModel,
      options: { chunkOverlap: config.ingestion.chunkOverlap },
    });
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
      rateLimiter: new RateLimiter({ limit: config.rateLimit.requests, windowMs: config.rateLimit.windowMs }),
    });

    return {
      bot,
      checkIndex: async () =>
        void (await checkIndexCompatibility(
          maintenance,
          {
            embeddingModel: embeddings.model,
            chunkSize: config.ingestion.chunkSize,
            chunkOverlap: config.ingestion.chunkOverlap,
          },
          logger,
        )),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Wires the re-indexing workflow for `npm run reindex` (no Telegram involved). Without an API key the
 * tool can still plan (`--dry-run`); anything that would embed fails with a clear message instead.
 */
export function createReindexTool(config: ToolConfig, credentials: { openaiApiKey?: string } = {}): ReindexTool {
  const embeddings = credentials.openaiApiKey
    ? createOpenAIEmbeddings({
        apiKey: credentials.openaiApiKey,
        model: config.openai.embeddingsModel,
        timeoutMs: config.openai.requestTimeoutMs,
      })
    : new OfflineEmbeddings(config.openai.embeddingsModel);
  const { db, documents, vectorStore, maintenance } = createStorage({
    storage: config.storage,
    embeddings,
    legacyEmbeddingModel: config.openai.embeddingsModel,
  });

  return {
    reindex: new RunReindexUseCase({
      maintenance,
      embeddings,
      chunking: config.chunking,
      reindexDocument: new ReindexDocumentUseCase({ documents, vectorStore, embeddings }),
      rechunkDocument: new RechunkDocumentUseCase({
        documents,
        files: new LocalFileStorage(config.storage.filesDir),
        extractor: new FileTextExtractor(),
        embeddings,
        options: { ...config.chunking, maxChunksPerDocument: config.limits.maxChunksPerDocument },
      }),
    }),
    close: () => db.close(),
  };
}
