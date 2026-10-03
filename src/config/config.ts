import path from "node:path";
import { z } from "zod";

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const envSchema = z
  .object({
    TELEGRAM_BOT_TOKEN: z.string().min(1),
    OPENAI_API_KEY: z.string().min(1),
    OPENAI_CHAT_MODEL: z.string().min(1).default("gpt-4.1-mini"),
    OPENAI_EMBEDDINGS_MODEL: z.string().min(1).default("text-embedding-3-small"),
    OPENAI_TRANSCRIBE_MODEL: z.string().min(1).default("whisper-1"),
    NODE_ENV: z.string().default("development"),

    DATA_DIR: z.string().min(1).default("data"),
    MAX_UPLOAD_BYTES: positiveInt(10 * 1024 * 1024),

    CHUNK_SIZE: positiveInt(1000),
    CHUNK_OVERLAP: z.coerce.number().int().min(0).default(150),
    RETRIEVAL_TOP_K: positiveInt(5),
    MIN_SIMILARITY_SCORE: z.coerce.number().min(-1).max(1).default(0.2),

    REQUEST_TIMEOUT_MS: positiveInt(60_000),
    HANDLER_TIMEOUT_MS: positiveInt(300_000),

    LOG_QUESTIONS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .refine((env) => env.CHUNK_OVERLAP < env.CHUNK_SIZE, {
    message: "CHUNK_OVERLAP must be smaller than CHUNK_SIZE",
    path: ["CHUNK_OVERLAP"],
  });

export type AppConfig = ReturnType<typeof loadConfig>;

/**
 * Parses and validates environment variables into a structured, immutable config.
 * Pure: pass any env-like object (tests do), nothing is read from the process implicitly.
 */
export function loadConfig(source: Record<string, string | undefined> = process.env) {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "env"}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  }

  const env = parsed.data;
  const dataDir = path.resolve(process.cwd(), env.DATA_DIR);

  return {
    nodeEnv: env.NODE_ENV,
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      handlerTimeoutMs: env.HANDLER_TIMEOUT_MS,
    },
    openai: {
      apiKey: env.OPENAI_API_KEY,
      chatModel: env.OPENAI_CHAT_MODEL,
      embeddingsModel: env.OPENAI_EMBEDDINGS_MODEL,
      transcribeModel: env.OPENAI_TRANSCRIBE_MODEL,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    },
    storage: {
      dataDir,
      filesDir: path.join(dataDir, "files"),
      sqlitePath: path.join(dataDir, "app.db"),
    },
    ingestion: {
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
      chunkSize: env.CHUNK_SIZE,
      chunkOverlap: env.CHUNK_OVERLAP,
      downloadTimeoutMs: env.REQUEST_TIMEOUT_MS,
    },
    retrieval: {
      topK: env.RETRIEVAL_TOP_K,
      minScore: env.MIN_SIMILARITY_SCORE,
    },
    logQuestions: env.LOG_QUESTIONS,
  } as const;
}
