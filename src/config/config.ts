import path from "node:path";
import { z } from "zod";

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

type EnvSource = Record<string, string | undefined>;
type Issues = { messages: string[]; variables: string[] };
type SectionResult<T> = { ok: true; value: T } | ({ ok: false } & Issues);

/**
 * An invalid or incomplete environment. The message lists every problem for a person reading it (the command-line tools print it);
 * `variables` is the trusted part: the names of the variables concerned, taken from the schema and never from the environment's
 * values, so a log can say what to fix without repeating anything that was entered.
 */
export class ConfigError extends Error {
  readonly stage = "config";
  constructor(
    message: string,
    readonly variables: readonly string[],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * One independently validated slice of the environment. Every entry point loads only the sections it
 * uses: the Telegram bot needs all of them, `npm run eval:retrieval` needs no secrets at all, and a
 * re-index dry run needs a model name but no API key. Pure: pass any env-like object (tests do).
 */
function section<S extends z.ZodType, T>(schema: S, build: (env: z.output<S>) => T) {
  const tryLoad = (source: EnvSource): SectionResult<T> => {
    const parsed = schema.safeParse(source);
    if (parsed.success) {
      return { ok: true, value: build(parsed.data) };
    }
    return {
      ok: false,
      messages: parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`),
      variables: parsed.error.issues.flatMap((issue) => (typeof issue.path[0] === "string" ? [issue.path[0]] : [])),
    };
  };

  return {
    tryLoad,
    load(source: EnvSource = process.env): T {
      const result = tryLoad(source);
      if (!result.ok) {
        throw configError(result);
      }
      return result.value;
    },
  };
}

function configError({ messages, variables }: Issues) {
  return new ConfigError(`Invalid configuration:\n- ${messages.join("\n- ")}`, [...new Set(variables)]);
}

/** Environment and storage locations. Needed by every command that opens the database. */
const baseConfig = section(
  z.object({
    NODE_ENV: z.string().default("development"),
    DATA_DIR: z.string().min(1).default("data"),
  }),
  (env) => {
    const dataDir = path.resolve(process.cwd(), env.DATA_DIR);
    return {
      nodeEnv: env.NODE_ENV,
      storage: {
        dataDir,
        filesDir: path.join(dataDir, "files"),
        sqlitePath: path.join(dataDir, "app.db"),
      },
    };
  },
);

/** Model names and timeouts - everything about OpenAI except the secret. Enough for offline tools. */
const openAiModelsConfig = section(
  z.object({
    OPENAI_CHAT_MODEL: z.string().min(1).default("gpt-4.1-mini"),
    OPENAI_EMBEDDINGS_MODEL: z.string().min(1).default("text-embedding-3-small"),
    OPENAI_TRANSCRIBE_MODEL: z.string().min(1).default("whisper-1"),
    REQUEST_TIMEOUT_MS: positiveInt(60_000),
  }),
  (env) => ({
    chatModel: env.OPENAI_CHAT_MODEL,
    embeddingsModel: env.OPENAI_EMBEDDINGS_MODEL,
    transcribeModel: env.OPENAI_TRANSCRIBE_MODEL,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
  }),
);

/** The models plus the API key: required by anything that really calls OpenAI. */
export const openAiConfig = section(
  z.object({ OPENAI_API_KEY: z.string().min(1) }),
  (env) => env.OPENAI_API_KEY,
);

/** How documents are split. These values are part of the index profile. */
const chunkingConfig = section(
  z
    .object({
      CHUNK_SIZE: positiveInt(1000),
      CHUNK_OVERLAP: z.coerce.number().int().min(0).default(150),
    })
    .refine((env) => env.CHUNK_OVERLAP < env.CHUNK_SIZE, {
      message: "CHUNK_OVERLAP must be smaller than CHUNK_SIZE",
      path: ["CHUNK_OVERLAP"],
    }),
  (env) => ({ chunkSize: env.CHUNK_SIZE, chunkOverlap: env.CHUNK_OVERLAP }),
);

/** Upload handling (bot only). */
const uploadConfig = section(
  z.object({ MAX_UPLOAD_BYTES: positiveInt(10 * 1024 * 1024), REQUEST_TIMEOUT_MS: positiveInt(60_000) }),
  (env) => ({ maxUploadBytes: env.MAX_UPLOAD_BYTES, downloadTimeoutMs: env.REQUEST_TIMEOUT_MS }),
);

/** Query-time settings. None of them is persisted, so changing them never makes an index stale. */
const retrievalConfig = section(
  z.object({
    RETRIEVAL_TOP_K: positiveInt(5),
    MIN_SIMILARITY_SCORE: z.coerce.number().min(-1).max(1).default(0.2),
    RETRIEVAL_SEMANTIC_LIMIT: positiveInt(20),
    RETRIEVAL_LEXICAL_LIMIT: positiveInt(20),
    RETRIEVAL_RRF_K: positiveInt(60),
    RETRIEVAL_CONTEXT_MAX_CHARS: positiveInt(6000),
    /** Extra rank evidence for chunks that contain an identifier/file name/version of the question verbatim. 0 turns it off. */
    RETRIEVAL_EXACT_TOKEN_BONUS: z.coerce.number().min(0).max(10).default(1),
    /**
     * The answerability gate: weak evidence is answered with "not enough information" instead of asking the model.
     * off = no gate; shadow = decide and log, but answer as if there were no gate; enforce = abstain on weak evidence.
     * Shadow is the default: the 0.5 threshold was calibrated on synthetic embeddings only and has not been
     * validated against real OpenAI embeddings, so it must not change answers until it has been observed.
     */
    RETRIEVAL_CONFIDENCE_MODE: z.enum(["off", "shadow", "enforce"]).default("shadow"),
    /** Removed switch (false = off, true = enforce). Rejected rather than ignored, so a deployment that relied on it cannot silently fall back to shadow. */
    RETRIEVAL_CONFIDENCE_GATE: z.never({ error: "was removed; use RETRIEVAL_CONFIDENCE_MODE=off, shadow or enforce" }).optional(),
    // Defaults mirror DEFAULT_CONFIDENCE_POLICY (core); a test keeps them equal. Cosine similarity is specific to the embedding model: re-calibrate (npm run eval:confidence) after changing it.
    RETRIEVAL_CONFIDENCE_MIN_SEMANTIC_SCORE: z.coerce.number().min(-1).max(1).default(0.5),
    RETRIEVAL_CONFIDENCE_MIN_TERM_COVERAGE: z.coerce.number().min(0).max(1).default(0.6),
  }),
  (env) => {
    const confidenceMode = env.RETRIEVAL_CONFIDENCE_MODE;

    return {
      topK: env.RETRIEVAL_TOP_K,
      minScore: env.MIN_SIMILARITY_SCORE,
      semanticLimit: env.RETRIEVAL_SEMANTIC_LIMIT,
      lexicalLimit: env.RETRIEVAL_LEXICAL_LIMIT,
      rrfK: env.RETRIEVAL_RRF_K,
      contextMaxChars: env.RETRIEVAL_CONTEXT_MAX_CHARS,
      exactTokenBonus: env.RETRIEVAL_EXACT_TOKEN_BONUS,
      confidenceMode,
      // Whether identifiers must exist in the documents is a rule, not an operational knob (see core/retrieval-confidence.ts).
      // Kept in shadow mode too: it is what the shadow decision is computed with. Absent only when the gate is off.
      confidence:
        confidenceMode !== "off"
          ? {
              minSemanticScore: env.RETRIEVAL_CONFIDENCE_MIN_SEMANTIC_SCORE,
              minTermCoverage: env.RETRIEVAL_CONFIDENCE_MIN_TERM_COVERAGE,
              requireKnownIdentifiers: true,
            }
          : undefined,
    };
  },
);

const limitsConfig = section(
  z.object({
    MAX_DOCUMENTS_PER_USER: positiveInt(100),
    MAX_STORAGE_BYTES_PER_USER: positiveInt(200 * 1024 * 1024),
    MAX_CHUNKS_PER_DOCUMENT: positiveInt(2000),
    MAX_CHUNKS_PER_USER: positiveInt(10_000),
    /** A PDF with more pages is refused before any text is extracted (a PDF of thousands of near-empty pages is small but slow to parse). */
    MAX_PDF_PAGES: positiveInt(1000),
  }),
  (env) => ({
    maxDocumentsPerUser: env.MAX_DOCUMENTS_PER_USER,
    maxStorageBytesPerUser: env.MAX_STORAGE_BYTES_PER_USER,
    maxChunksPerDocument: env.MAX_CHUNKS_PER_DOCUMENT,
    maxChunksPerUser: env.MAX_CHUNKS_PER_USER,
    maxPdfPages: env.MAX_PDF_PAGES,
  }),
);

/** Telegram delivery: the only section that needs the bot token. Loaded only when the bot starts. */
export const telegramConfig = section(
  z.object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    HANDLER_TIMEOUT_MS: positiveInt(300_000),
    RATE_LIMIT_REQUESTS: positiveInt(10),
    RATE_LIMIT_WINDOW_MS: positiveInt(60_000),
  }),
  (env) => ({
    telegram: { botToken: env.TELEGRAM_BOT_TOKEN, handlerTimeoutMs: env.HANDLER_TIMEOUT_MS },
    rateLimit: { requests: env.RATE_LIMIT_REQUESTS, windowMs: env.RATE_LIMIT_WINDOW_MS },
  }),
);

const diagnosticsConfig = section(
  z.object({ LOG_QUESTIONS: booleanFlag, RAG_DEBUG: booleanFlag, FEEDBACK_BUTTONS: booleanFlag }),
  (env) => ({ logQuestions: env.LOG_QUESTIONS, ragDebug: env.RAG_DEBUG, feedbackButtons: env.FEEDBACK_BUTTONS }),
);

/**
 * The values of every section - or, when any section is invalid, one error that lists the problems of all of them at once
 * (a variable read by two sections is reported once).
 */
function collect<R extends Record<string, SectionResult<unknown>>>(sections: R) {
  const failures = Object.values(sections).flatMap((result) => (result.ok ? [] : [result]));
  const messages = [...new Set(failures.flatMap((result) => result.messages))];
  if (messages.length > 0) {
    throw configError({ messages, variables: failures.flatMap((result) => result.variables) });
  }
  const values = Object.entries(sections).map(([name, result]) => [name, (result as { value: unknown }).value]);
  return Object.fromEntries(values) as { [K in keyof R]: R[K] extends SectionResult<infer T> ? T : never };
}

export type AppConfig = ReturnType<typeof loadConfig>;

/** The part of the configuration the application core (everything but Telegram delivery and the OpenAI key) needs. */
export type CoreConfig = Pick<AppConfig, "storage" | "ingestion" | "retrieval" | "limits" | "logQuestions" | "ragDebug">;

/**
 * The core's configuration without any secret: what `npm run smoke` and the end-to-end tests load. The bot token and the API key
 * are not part of it, so a process that only needs the core runs without them.
 */
export function loadCoreConfig(source: EnvSource = process.env): CoreConfig {
  const config = collect({
    base: baseConfig.tryLoad(source),
    chunking: chunkingConfig.tryLoad(source),
    upload: uploadConfig.tryLoad(source),
    retrieval: retrievalConfig.tryLoad(source),
    limits: limitsConfig.tryLoad(source),
    diagnostics: diagnosticsConfig.tryLoad(source),
  });

  return {
    storage: config.base.storage,
    ingestion: { ...config.upload, ...config.chunking },
    retrieval: config.retrieval,
    limits: config.limits,
    logQuestions: config.diagnostics.logQuestions,
    ragDebug: config.diagnostics.ragDebug,
  };
}

/** What the maintenance and evaluation commands share: storage, models, chunking, retrieval, limits. No secrets. */
export type ToolConfig = ReturnType<typeof loadToolConfig>;

/** Configuration for commands that never talk to Telegram (reindex, evaluation, benchmark). */
export function loadToolConfig(source: EnvSource = process.env) {
  const config = collect({
    base: baseConfig.tryLoad(source),
    models: openAiModelsConfig.tryLoad(source),
    chunking: chunkingConfig.tryLoad(source),
    retrieval: retrievalConfig.tryLoad(source),
    limits: limitsConfig.tryLoad(source),
  });

  return {
    nodeEnv: config.base.nodeEnv,
    storage: config.base.storage,
    openai: config.models,
    chunking: config.chunking,
    retrieval: config.retrieval,
    limits: config.limits,
  } as const;
}

/** Full configuration of the Telegram bot: every section, validated together so a misconfigured deployment reports all of its problems at once. */
export function loadConfig(source: EnvSource = process.env) {
  const config = collect({
    base: baseConfig.tryLoad(source),
    models: openAiModelsConfig.tryLoad(source),
    key: openAiConfig.tryLoad(source),
    chunking: chunkingConfig.tryLoad(source),
    upload: uploadConfig.tryLoad(source),
    retrieval: retrievalConfig.tryLoad(source),
    limits: limitsConfig.tryLoad(source),
    telegram: telegramConfig.tryLoad(source),
    diagnostics: diagnosticsConfig.tryLoad(source),
  });

  return {
    nodeEnv: config.base.nodeEnv,
    telegram: config.telegram.telegram,
    openai: { apiKey: config.key, ...config.models },
    storage: config.base.storage,
    ingestion: { ...config.upload, ...config.chunking },
    retrieval: config.retrieval,
    limits: config.limits,
    rateLimit: config.telegram.rateLimit,
    logQuestions: config.diagnostics.logQuestions,
    ragDebug: config.diagnostics.ragDebug,
    feedbackButtons: config.diagnostics.feedbackButtons,
  } as const;
}
