import fs from "node:fs";
import type { Telegraf } from "telegraf";
import { runStartupCheck } from "./application/startup-check.js";
import { HybridRetriever } from "./application/hybrid-retriever.js";
import { AnswerQuestionUseCase } from "./application/use-cases/answer-question.use-case.js";
import { DeleteDocumentUseCase } from "./application/use-cases/delete-document.use-case.js";
import { GetDocumentUseCase } from "./application/use-cases/get-document.use-case.js";
import { IngestDocumentUseCase } from "./application/use-cases/ingest-document.use-case.js";
import { RecordFeedbackUseCase } from "./application/use-cases/record-feedback.use-case.js";
import { InspectIntegrityUseCase } from "./application/use-cases/inspect-integrity.use-case.js";
import { ListDocumentsUseCase } from "./application/use-cases/list-documents.use-case.js";
import { RechunkDocumentUseCase } from "./application/use-cases/rechunk-document.use-case.js";
import { ReindexDocumentUseCase } from "./application/use-cases/reindex-document.use-case.js";
import { RepairIntegrityUseCase } from "./application/use-cases/repair-integrity.use-case.js";
import { ReplaceDocumentUseCase } from "./application/use-cases/replace-document.use-case.js";
import { RunReindexUseCase } from "./application/use-cases/run-reindex.use-case.js";
import { SummarizeDocumentUseCase } from "./application/use-cases/summarize-document.use-case.js";
import type { AppConfig, ToolConfig } from "./config/config.js";
import type { EmbeddingsProvider } from "./application/ports/embeddings-provider.js";
import { FileTextExtractor } from "./infrastructure/documents/file-text-extractor.js";
import { createOpenAIChatModel } from "./infrastructure/openai/openai-chat-model.js";
import { createOpenAIEmbeddings } from "./infrastructure/openai/openai-embeddings.js";
import { OfflineEmbeddings } from "./infrastructure/openai/offline-embeddings.js";
import { OpenAISpeechToText } from "./infrastructure/openai/openai-speech-to-text.js";
import { openDatabase, openDatabaseReadOnly } from "./infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "./infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteIndexMaintenance } from "./infrastructure/sqlite/sqlite-index-maintenance.js";
import { InMemoryAnswerOutcomes } from "./infrastructure/memory/answer-outcomes.js";
import { SqliteFeedbackStore } from "./infrastructure/sqlite/sqlite-feedback-store.js";
import { SqliteIntegrityStore } from "./infrastructure/sqlite/sqlite-integrity-store.js";
import { SqliteVectorStore } from "./infrastructure/sqlite/sqlite-vector-store.js";
import { LocalFileStorage } from "./infrastructure/storage/local-file-storage.js";
import { StartupError } from "./shared/errors.js";
import { KeyedMutex } from "./shared/keyed-mutex.js";
import { logger } from "./shared/logger.js";
import { RateLimiter } from "./shared/rate-limiter.js";
import { createBot } from "./telegram/bot.js";

export type Application = {
  bot: Telegraf;
  /** What the startup stages report: the migrated schema version and where the data lives. */
  readiness: { schemaVersion: number; dataDir: string };
  /**
   * The cheap startup health summary (outdated indexes, missing originals, leftover temporary files). Reads only:
   * it never calls a provider, never repairs, and never throws away data. Deep checks: `npm run integrity`.
   */
  startupCheck(): Promise<void>;
  /** Releases resources held by the infrastructure (the SQLite connection). */
  close(): void;
};

export type IntegrityTool = {
  inspect: InspectIntegrityUseCase;
  /** Present only when the tool was opened writable (`--repair`); a read-only tool has no way to change anything. */
  repair?: RepairIntegrityUseCase;
  close(): void;
};

export type ReindexTool = {
  reindex: RunReindexUseCase;
  close(): void;
};

/** What the adapters shared by the bot and the maintenance CLI need; no Telegram settings. */
type StorageSettings = {
  storage: { dataDir: string; filesDir: string; sqlitePath: string };
  embeddings: EmbeddingsProvider;
  legacyEmbeddingModel: string;
};

/** Prepares the data directory and opens (and migrates) the database; failures name the stage that failed. */
function createStorage(settings: StorageSettings) {
  try {
    fs.mkdirSync(settings.storage.filesDir, { recursive: true });
    fs.accessSync(settings.storage.filesDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw new StartupError("storage", error);
  }

  let db: ReturnType<typeof openDatabase>;
  try {
    db = openDatabase(settings.storage.sqlitePath, { legacyEmbeddingModel: settings.legacyEmbeddingModel });
  } catch (error) {
    throw new StartupError("database", error);
  }

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
    chunkSize: config.ingestion.chunkSize,
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
    // One lock per user, shared by every use case that adds, replaces or re-checks that user's documents.
    const userLocks = new KeyedMutex();
    const ingestDocument = new IngestDocumentUseCase({
      documents,
      files,
      extractor,
      embeddings,
      locks: userLocks,
      options: { ...config.ingestion, ...config.limits },
    });
    const replaceDocument = new ReplaceDocumentUseCase({
      documents,
      files,
      extractor,
      embeddings,
      locks: userLocks,
      options: { ...config.ingestion, ...config.limits },
    });
    const overview = {
      documents,
      maintenance,
      files,
      recipe: { embeddingModel: embeddings.model, chunkSize: config.ingestion.chunkSize, chunkOverlap: config.ingestion.chunkOverlap },
    };
    const outcomes = new InMemoryAnswerOutcomes();
    const answerQuestion = new AnswerQuestionUseCase({
      retriever: new HybridRetriever({ embeddings, vectorStore, options: config.retrieval }),
      chatModel,
      outcomes,
      options: { logQuestions: config.logQuestions, ragDebug: config.ragDebug },
    });
    const listDocuments = new ListDocumentsUseCase(overview);
    const getDocument = new GetDocumentUseCase(overview);
    const summarizeDocument = new SummarizeDocumentUseCase({
      documents,
      vectorStore,
      chatModel,
      options: { chunkOverlap: config.ingestion.chunkOverlap },
    });
    const deleteDocument = new DeleteDocumentUseCase({ documents, vectorStore, files, locks: userLocks });

    // Delivery
    const bot = createBot(config.telegram.botToken, config.telegram.handlerTimeoutMs, {
      ingestDocument,
      replaceDocument,
      getDocument,
      answerQuestion,
      listDocuments,
      summarizeDocument,
      deleteDocument,
      speechToText,
      downloadLimits: { maxBytes: config.ingestion.maxUploadBytes, timeoutMs: config.ingestion.downloadTimeoutMs },
      rateLimiter: new RateLimiter({ limit: config.rateLimit.requests, windowMs: config.rateLimit.windowMs }),
      feedback: config.feedbackButtons ? new RecordFeedbackUseCase({ store: new SqliteFeedbackStore(db), outcomes }) : undefined,
    });

    return {
      bot,
      readiness: { schemaVersion: db.pragma("user_version", { simple: true }) as number, dataDir: config.storage.dataDir },
      startupCheck: async () =>
        void (await runStartupCheck({
          store: new SqliteIntegrityStore(db),
          maintenance,
          files,
          recipe: {
            embeddingModel: embeddings.model,
            chunkSize: config.ingestion.chunkSize,
            chunkOverlap: config.ingestion.chunkOverlap,
          },
          now: Date.now,
          log: logger,
        })),
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
        chunkSize: config.chunking.chunkSize,
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

/**
 * Wires `npm run integrity`. Read-only by default: the database is opened with SQLite's read-only flag (and
 * not migrated), so even a bug could not write to it. `writable` (the explicit `--repair`) opens it normally.
 * Neither mode has an embeddings provider or any API key: nothing here can call OpenAI.
 */
export function createIntegrityTool(
  config: ToolConfig,
  options: { writable: boolean; verifyHashes: boolean; now?: () => number },
): IntegrityTool {
  const db = options.writable
    ? openDatabase(config.storage.sqlitePath, { legacyEmbeddingModel: config.openai.embeddingsModel })
    : openDatabaseReadOnly(config.storage.sqlitePath);

  try {
    const store = new SqliteIntegrityStore(db);
    const files = new LocalFileStorage(config.storage.filesDir);
    const now = options.now ?? Date.now;
    const inspect = new InspectIntegrityUseCase({
      store,
      maintenance: new SqliteIndexMaintenance(db),
      files,
      recipe: { embeddingModel: config.openai.embeddingsModel, ...config.chunking },
      now,
      verifyHashes: options.verifyHashes,
    });

    return {
      inspect,
      repair: options.writable ? new RepairIntegrityUseCase({ inspect, store, documents: new SqliteDocumentRepository(db), files, now }) : undefined,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

