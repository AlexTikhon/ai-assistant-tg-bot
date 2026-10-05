import pino from "pino";
import type { DestinationStream } from "pino";
import { currentRequestId } from "./request-context.js";
import { scrubDeep, scrubSecrets } from "./scrub.js";

// The one definition of what a secret looks like lives in scrub.ts; it is re-exported here for the code that already imports it from the logger.
export { scrubSecrets };

type SerializedError = { type?: string; message?: string; stack?: string; cause?: unknown; [key: string]: unknown };

/** Serializes an error for the log with every string in it (message, stack, extra properties such as a url) scrubbed, causes included. */
function scrubError(error: unknown): unknown {
  const serialized = scrubDeep(pino.stdSerializers.err(error as Error)) as SerializedError;
  if (error instanceof Error && error.cause !== undefined) serialized.cause = scrubError(error.cause);
  return serialized;
}

/**
 * Structured JSON logger.
 *
 * Conventions (the full rule is in docs/security.md, "What may be logged"): ids, counts, ranks, durations, health states and error
 * categories - never question or answer text, document or chunk text, embeddings, tokens or keys.
 * Lines logged inside a Telegram update also carry its `requestId`.
 * Errors go under the `err` key so they are serialized (and scrubbed) consistently.
 */
export function createLogger(destination?: DestinationStream, level = process.env.LOG_LEVEL ?? "info") {
  return pino(
    {
      level,
      serializers: { err: scrubError },
      // Whatever is logged, strings that look like a token or a key never reach the output. (Errors are scrubbed by their serializer above.)
      formatters: {
        log: ({ err, ...fields }: Record<string, unknown>) => ({ ...(scrubDeep(fields) as Record<string, unknown>), ...(err === undefined ? {} : { err }) }),
      },
      // Every line logged while an update is being handled carries its short request id (see request-context.ts).
      mixin: () => {
        const requestId = currentRequestId();
        return requestId ? { requestId } : {};
      },
      redact: {
        paths: ["apiKey", "botToken", "token", "authorization", "headers.authorization", "*.apiKey", "*.botToken", "*.token"],
        censor: "[redacted]",
      },
    },
    destination,
  );
}

export const logger = createLogger();

export type Logger = typeof logger;

/** The one-method views of a logger that application code needs (so tests can pass a plain function). */
type LogFn = (fields: Record<string, unknown>, message: string) => void;
export type InfoLog = { info: LogFn };
export type WarnLog = { warn: LogFn };
