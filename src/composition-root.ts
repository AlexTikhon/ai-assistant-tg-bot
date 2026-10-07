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
import type { AppConfig, CoreConfig, ToolConfig } from "./config/config.js";
import type { ChatModel } from "./application/ports/chat-model.js";
import type { EmbeddingsProvider } from "./application/ports/embeddings-provider.js";
import type { SpeechToText } from "./application/ports/speech-to-text.js";
import { FileTextExtractor } from "./infrastructure/documents/file-text-extractor.js";
import { createOpenAIChatModel } from "./infrastructure/openai/openai-chat-model.js";
import { createOpenAIEmbeddings } from "./infrastructure/openai/openai-embeddings.js";
import { OfflineEmbeddings } from "./infrastructure/openai/offline-embeddings.js";
import { OpenAISpeechToText } from "./infrastructure/openai/openai-speech-to-text.js";
import { classifyDatabaseError, openDatabase, openDatabaseReadOnly, quickCheck } from "./infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "./infrastructure/sqlite/sqlite-document-repository.js";
import { SqliteIndexMaintenance } from "./infrastructure/sqlite/sqlite-index-maintenance.js";
import { InMemoryAnswerOutcomes } from "./infrastructure/memory/answer-outcomes.js";
import { SqliteFeedbackStore } from "./infrastructure/sqlite/sqlite-feedback-store.js";
import { SqliteIntegrityStore } from "./infrastructure/sqlite/sqlite-integrity-store.js";
import { SqliteVectorStore } from "./infrastructure/sqlite/sqlite-vector-store.js";
import { DataDirectoryRestoreArtifacts } from "./infrastructure/backup/restore-artifacts.js";
import { LocalFileStorage } from "./infrastructure/storage/local-file-storage.js";
import { StartupError } from "./shared/errors.js";
import { ensurePrivateDirectory } from "./shared/fs-permissions.js";
import { KeyedMutex } from "./shared/keyed-mutex.js";
import { logger } from "./shared/logger.js";
import { RateLimiter } from "./shared/rate-limiter.js";
import { APPLICATION_VERSION } from "./shared/version.js";
import { createBot } from "./telegram/bot.js";
import { Operations } from "./shared/operation.js";
import { SemanticScanner } from "./infrastructure/sqlite/semantic-scanner.js";
import { SqliteUpdateClaimStore } from "./infrastructure/sqlite/sqlite-update-claims.js";
import { recoverUpdateClaims } from "./telegram/update-claims.js";

export type Application = {
  bot: Telegraf;
  /** What the startup stages report: the migrated schema version, where the data lives, the version, the confidence mode and whether question text is logged. */
  readiness: { schemaVersion: number; dataDir: string; version: string; confidenceMode: "off" | "shadow" | "enforce"; logQuestions: boolean };
  /**
   * The cheap startup health summary (outdated indexes, missing originals, leftover temporary files). Reads only:
   * it never calls a provider, never repairs, and never throws away data. Deep checks: `npm run integrity`.
   */
  startupCheck(): Promise<void>;
  /** Releases resources held by the infrastructure (the SQLite connection). */
  close(): void;
  /** Cancels new/in-flight updates and waits for actual work before releasing storage. */
  drain(): Promise<void>;
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

/** The external services. Everything else in the application is real; tests and `npm run smoke` pass offline fakes here. */
export type Providers = {
  embeddings: EmbeddingsProvider;
  chatModel: ChatModel;
  speechToText: SpeechToText;
};

/** What the adapters shared by the bot and the maintenance CLI need; no Telegram settings. */
type StorageSettings = {
  storage: { dataDir: string; filesDir: string; sqlitePath: string };
  embeddings: EmbeddingsProvider;
};

/**
 * Prepares the data directory and opens (and migrates) the database; failures name the stage that failed.
 * A damaged database file is detected here, before anything is served: SQLite's structural check reads every page once.
 * Nothing is repaired or replaced automatically - the error tells the operator about backup verification and restore.
 */
function createStorage(settings: StorageSettings) {
  try {
    ensurePrivateDirectory(settings.storage.dataDir);
    ensurePrivateDirectory(settings.storage.filesDir);
    fs.accessSync(settings.storage.filesDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (error) {
    throw new StartupError("storage", error);
  }

  let db: ReturnType<typeof openDatabase>;
  try {
    // Chunks stored before models were tracked are assumed to come from the model the application runs with.
    db = openDatabase(settings.storage.sqlitePath, { legacyEmbeddingModel: settings.embeddings.model });
  } catch (error) {
    throw new StartupError("database", error, classifyDatabaseError(error).advice || undefined);
  }

  try {
    const damage = quickCheck(db);
    if (damage.length > 0) {
      throw new StartupError("database", new Error(`The database failed SQLite's structural check: ${damage[0]}`), classifyDatabaseError({ code: "SQLITE_CORRUPT" }).advice);
    }
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

/** The real OpenAI-backed providers. */
function createOpenAiProviders(config: AppConfig): Providers {
  return {
    embeddings: createOpenAIEmbeddings({
      apiKey: config.openai.apiKey,
      model: config.openai.embeddingsModel,
      timeoutMs: config.openai.requestTimeoutMs,
      chunkSize: config.ingestion.chunkSize,
    }),
    chatModel: createOpenAIChatModel({ apiKey: config.openai.apiKey, model: config.openai.chatModel, timeoutMs: config.openai.requestTimeoutMs }),
    speechToText: new OpenAISpeechToText({ apiKey: config.openai.apiKey, model: config.openai.transcribeModel, timeoutMs: config.openai.requestTimeoutMs }),
  };
}

/** Everything the application is made of except the Telegram delivery: real storage, retrieval and use cases around the given providers. */
export type Core = {
  db: ReturnType<typeof openDatabase>;
  files: LocalFileStorage;
  documents: SqliteDocumentRepository;
  useCases: {
    ingestDocument: IngestDocumentUseCase;
    replaceDocument: ReplaceDocumentUseCase;
    getDocument: GetDocumentUseCase;
    answerQuestion: AnswerQuestionUseCase;
    listDocuments: ListDocumentsUseCase;
    summarizeDocument: SummarizeDocumentUseCase;
    deleteDocument: DeleteDocumentUseCase;
  };
  outcomes: InMemoryAnswerOutcomes;
  readiness: Application["readiness"];
  startupCheck(): Promise<void>;
  /** Stops and joins semantic worker jobs. Application shutdown calls this after draining updates. */
  drain(): Promise<void>;
  close(): void;
};

/**
 * The application without Telegram: the one place that builds the real repositories, storage, retrieval and use cases.
 * The bot, `npm run smoke` and the end-to-end tests all go through it, so what they exercise is what runs in production;
 * only the providers differ.
 */
export function createCore(config: CoreConfig, providers: Providers): Core {
  const { embeddings, chatModel } = providers;
  const { db, documents, vectorStore, maintenance } = createStorage({ storage: config.storage, embeddings });

  try {
    const scanner = new SemanticScanner(config.storage.sqlitePath);
    const queryStore = new SqliteVectorStore(db, scanner);
    const files = new LocalFileStorage(config.storage.filesDir);
    const extractor = new FileTextExtractor({ maxPdfPages: config.limits.maxPdfPages });

    // One lock per user, shared by every use case that adds, replaces or re-checks that user's documents.
    const userLocks = new KeyedMutex();
    const ingestionOptions = { ...config.ingestion, ...config.limits };
    const ingestDocument = new IngestDocumentUseCase({ documents, files, extractor, embeddings, locks: userLocks, options: ingestionOptions });
    const replaceDocument = new ReplaceDocumentUseCase({ documents, files, extractor, embeddings, locks: userLocks, options: ingestionOptions });
    const recipe = { embeddingModel: embeddings.model, chunkSize: config.ingestion.chunkSize, chunkOverlap: config.ingestion.chunkOverlap };
    const overview = { documents, maintenance, files, recipe };
    const outcomes = new InMemoryAnswerOutcomes();
    const answerQuestion = new AnswerQuestionUseCase({
      retriever: new HybridRetriever({ embeddings, vectorStore: queryStore, options: config.retrieval }),
      chatModel,
      documents,
      outcomes,
      options: { logQuestions: config.logQuestions, ragDebug: config.ragDebug },
    });

    return {
      db,
      files,
      documents,
      useCases: {
        ingestDocument,
        replaceDocument,
        getDocument: new GetDocumentUseCase(overview),
        answerQuestion,
        listDocuments: new ListDocumentsUseCase(overview),
        summarizeDocument: new SummarizeDocumentUseCase({ documents, vectorStore, chatModel, options: { chunkOverlap: config.ingestion.chunkOverlap } }),
        deleteDocument: new DeleteDocumentUseCase({ documents, vectorStore, files, locks: userLocks }),
      },
      outcomes,
      readiness: {
        schemaVersion: db.pragma("user_version", { simple: true }) as number,
        dataDir: config.storage.dataDir,
        version: APPLICATION_VERSION,
        confidenceMode: config.retrieval.confidenceMode,
        logQuestions: config.logQuestions,
      },
      startupCheck: async () => void (await runStartupCheck({ store: new SqliteIntegrityStore(db), maintenance, files, recipe, now: Date.now, log: logger })),
      drain: () => scanner.close(),
      close: () => { void scanner.close(); db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The Telegram bot around a core. The providers default to the real OpenAI ones; the adapter contract tests pass fakes.
 * Delivery only: it adds the bot, the per-user rate limiter and the optional feedback buttons to what createCore built.
 */
export function createApplication(
  config: AppConfig,
  providers: Providers = createOpenAiProviders(config),
  telegram?: Parameters<typeof createBot>[3],
  options: { now?: () => number } = {},
): Application {
  const core = createCore(config, providers);
  const operations = new Operations();

  try {
    // Bot application only (never createCore, so CLI tools and smoke runs cannot touch it): claims left running by a previous process
    // become interrupted before this one can receive anything.
    const updateClaims = new SqliteUpdateClaimStore(core.db, options);
    try {
      recoverUpdateClaims(updateClaims);
    } catch (error) {
      throw new StartupError("database", error);
    }
    const bot = createBot(config.telegram.botToken, config.telegram.handlerTimeoutMs, {
      ...core.useCases,
      speechToText: providers.speechToText,
      downloadLimits: { maxBytes: config.ingestion.maxUploadBytes, timeoutMs: config.ingestion.downloadTimeoutMs },
      rateLimiter: new RateLimiter({ limit: config.rateLimit.requests, windowMs: config.rateLimit.windowMs }),
      feedback: config.feedbackButtons ? new RecordFeedbackUseCase({ store: new SqliteFeedbackStore(core.db), outcomes: core.outcomes }) : undefined,
      operations,
      updateClaims,
    }, telegram);

    return {
      bot, readiness: core.readiness, startupCheck: core.startupCheck,
      // The ledger stops touching SQLite first: an update that finishes after this point leaves its claim exactly as it is.
      close: () => { updateClaims.close(); core.close(); },
      drain: async () => { await operations.shutdown(); await core.drain(); },
    };
  } catch (error) {
    core.close();
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
  const { db, documents, vectorStore, maintenance } = createStorage({ storage: config.storage, embeddings });

  return {
    reindex: new RunReindexUseCase({
      maintenance,
      embeddings,
      chunking: config.chunking,
      reindexDocument: new ReindexDocumentUseCase({ documents, vectorStore, embeddings }),
      rechunkDocument: new RechunkDocumentUseCase({
        documents,
        files: new LocalFileStorage(config.storage.filesDir),
        extractor: new FileTextExtractor({ maxPdfPages: config.limits.maxPdfPages }),
        embeddings,
        options: { ...config.chunking, maxChunksPerDocument: config.limits.maxChunksPerDocument, maxChunksPerUser: config.limits.maxChunksPerUser },
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
    const restoreArtifacts = new DataDirectoryRestoreArtifacts(config.storage.dataDir);
    const inspect = new InspectIntegrityUseCase({
      store,
      maintenance: new SqliteIndexMaintenance(db),
      files,
      recipe: { embeddingModel: config.openai.embeddingsModel, ...config.chunking },
      now,
      verifyHashes: options.verifyHashes,
      deepFullText: true, // an explicit operator command: it may read the whole database once
      restoreArtifacts,
    });

    return {
      inspect,
      repair: options.writable ? new RepairIntegrityUseCase({ inspect, store, documents: new SqliteDocumentRepository(db), files, restoreArtifacts, now }) : undefined,
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
