import { createHmac, randomBytes } from "node:crypto";
import pino from "pino";
import type { DestinationStream } from "pino";
import { currentRequestId } from "./request-context.js";
import { toSafeError } from "./safe-error.js";
import type { SafeError, TruncatedCause } from "./safe-error.js";
import { scrubDeep, scrubSecrets } from "./scrub.js";

// The one definition of what a secret looks like lives in scrub.ts; it is re-exported here for the code that already imports it from the logger.
export { scrubSecrets };

/**
 * What a log line says about an error: the bounded, content-free projection of safe-error.ts (category, known type/code/service/
 * method, status, retry delay, cause chain) - never the message, stack or any other property. The projection is scrubbed as well,
 * as defense in depth; it cannot throw, and neither can this.
 */
function serializeError(error: unknown): unknown {
  try {
    return scrubChain(toSafeError(error));
  } catch {
    return { category: "unknown", type: "unserializable" };
  }
}

/** scrubDeep for a record and its cause chain, one level at a time (scrubDeep alone would cut a chain off at its own depth limit). */
function scrubChain(record: SafeError | TruncatedCause): SafeError | TruncatedCause {
  if (!("category" in record)) return record;
  const { cause, ...fields } = record;
  return { ...(scrubDeep(fields) as Omit<SafeError, "cause">), ...(cause === undefined ? {} : { cause: scrubChain(cause) }) };
}

// Random per process and never written anywhere: a pseudonym is stable while the process runs and different after a restart.
const pseudonymKey = randomBytes(16);

/**
 * What a log line says instead of a Telegram user id: "u-" and 8 hex characters of a keyed hash. It lets one user's lines be
 * correlated within a run without putting a stable, identifying number into logs. It is for correlation only, not a security
 * boundary (the id space is small, so anyone holding the key could test guesses - and the key lives only in this process's
 * memory). Authorization never uses it: everything else in the application works with the real id.
 */
export function pseudonymizeUserId(userId: string | number) {
  return `u-${createHmac("sha256", pseudonymKey).update(String(userId)).digest("hex").slice(0, 8)}`;
}

/**
 * Structured JSON logger.
 *
 * Conventions (the full rule is in docs/security.md, "What may be logged"): ids, counts, ranks, durations, health states and error
 * categories - never question or answer text, document or chunk text, embeddings, tokens or keys.
 * Lines logged inside a Telegram update also carry its `requestId`.
 * A `userId` field is never written as it is: the line carries `user` (see pseudonymizeUserId) instead.
 * Errors go under the `err` key so they are reduced to safe facts consistently: an error's message, stack, payload and other
 * properties are never written (not even with LOG_QUESTIONS), only its category and known codes - see safe-error.ts.
 */
export function createLogger(destination?: DestinationStream, level = process.env.LOG_LEVEL ?? "info") {
  return pino(
    {
      level,
      serializers: { err: serializeError },
      // Whatever is logged, strings that look like a token or a key never reach the output. (Errors are reduced to safe facts by their serializer above.)
      formatters: {
        log: ({ err, userId, ...fields }: Record<string, unknown>) => ({
          ...(scrubDeep(fields) as Record<string, unknown>),
          ...(userId === undefined ? {} : { user: pseudonymizeUserId(String(userId)) }),
          ...(err === undefined ? {} : { err }),
        }),
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

/** The one-method views of a logger that application code needs (so tests can pass a plain function). */
type LogFn = (fields: Record<string, unknown>, message: string) => void;
export type InfoLog = { info: LogFn };
export type WarnLog = { warn: LogFn };
