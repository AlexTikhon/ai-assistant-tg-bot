import pino from "pino";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Telegram bot tokens, also when embedded in api.telegram.org URLs.
  // No leading \b: in URLs the token follows "bot" directly ("/bot123456:ABC...").
  [/\d{6,}:[A-Za-z0-9_-]{30,}/g, "[redacted-telegram-token]"],
  // OpenAI-style API keys.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-api-key]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
];

/** Removes anything that looks like a bot token or API key from free-form text. */
export function scrubSecrets(text: string) {
  return SECRET_PATTERNS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

type SerializedError = { type?: string; message?: string; stack?: string; cause?: unknown; [key: string]: unknown };

function scrubError(error: unknown): unknown {
  const serialized = pino.stdSerializers.err(error as Error) as SerializedError;
  if (typeof serialized.message === "string") serialized.message = scrubSecrets(serialized.message);
  if (typeof serialized.stack === "string") serialized.stack = scrubSecrets(serialized.stack);
  if (error instanceof Error && error.cause !== undefined) serialized.cause = scrubError(error.cause);
  return serialized;
}

/**
 * Structured JSON logger.
 *
 * Conventions: log ids, sizes and durations - never document text, embeddings or secrets.
 * Errors go under the `err` key so they are serialized (and scrubbed) consistently.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: { err: scrubError },
  redact: {
    paths: ["apiKey", "botToken", "token", "authorization", "headers.authorization", "*.apiKey", "*.botToken", "*.token"],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
