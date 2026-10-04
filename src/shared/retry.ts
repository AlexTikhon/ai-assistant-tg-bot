/**
 * Bounded retry for calls to external services - used only where a repeat is safe and cheap (speech-to-text,
 * Telegram file downloads). The OpenAI embeddings and chat clients already retry transient failures inside
 * their SDK (maxRetries, honouring Retry-After); wrapping them again would multiply paid calls, so they are not
 * wrapped here.
 *
 * What is repeated: HTTP 429/408 and 5xx (except 501/505), network resets and timeouts. What is never
 * repeated: other 4xx (401, 403, 404, 413, 422 ...), a caller's abort, validation errors and anything unknown.
 */

/** An HTTP failure with the facts a retry decision needs (status, and the provider's Retry-After). */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;

  constructor(message: string, details: { status: number; retryAfterMs?: number }) {
    super(message);
    this.name = "HttpStatusError";
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export type Failure = { retryable: boolean; retryAfterMs?: number };

const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPIPE", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"]);

type Loose = {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  name?: unknown;
  retryAfterMs?: unknown;
  headers?: unknown;
  response?: { error_code?: unknown; status?: unknown; parameters?: { retry_after?: unknown }; headers?: unknown };
  cause?: unknown;
};

function statusOf(error: Loose): number | undefined {
  for (const candidate of [error.status, error.statusCode, error.response?.error_code, error.response?.status]) {
    if (typeof candidate === "number") return candidate;
  }
  return undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/** Seconds ("4") or an HTTP date, as milliseconds from now. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function retryAfterOf(error: Loose): number | undefined {
  if (typeof error.retryAfterMs === "number") return error.retryAfterMs;
  const telegram = error.response?.parameters?.retry_after;
  if (typeof telegram === "number") return telegram * 1000;
  return parseRetryAfter(headerValue(error.headers, "retry-after") ?? headerValue(error.response?.headers, "retry-after"));
}

/** Decides whether repeating the call could help, and how long the provider asked to wait. Pure. */
export function classifyFailure(error: unknown, depth = 0): Failure {
  if (!error || typeof error !== "object" || depth > 4) {
    return { retryable: false };
  }
  const loose = error as Loose;

  const status = statusOf(loose);
  if (status !== undefined) {
    const retryable = status === 429 || status === 408 || (status >= 500 && status !== 501 && status !== 505);
    const retryAfterMs = retryAfterOf(loose);
    return retryAfterMs === undefined ? { retryable } : { retryable, retryAfterMs };
  }

  if (loose.name === "AbortError") {
    return { retryable: false }; // the caller gave up: never fight that
  }
  if (loose.name === "TimeoutError" || (typeof loose.code === "string" && TRANSIENT_CODES.has(loose.code))) {
    return { retryable: true };
  }

  return loose.cause === undefined ? { retryable: false } : classifyFailure(loose.cause, depth + 1);
}

export type RetryOptions = {
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  /** Delay before the second attempt; doubled each time. Default 250 ms. */
  baseDelayMs?: number;
  /** Upper bound of the backoff. Default 4000 ms. */
  maxDelayMs?: number;
  /** A provider-requested wait above this is not honoured: the call fails instead of holding the user up. Default 10 s. */
  maxRetryAfterMs?: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 0..1, injectable for tests; adds up to 25% jitter. */
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Runs `operation`, repeating it after a transient failure - at most `maxAttempts` times in total, with
 * exponential backoff and jitter, or after the provider's Retry-After. Every wait can be aborted. The last
 * error is rethrown unchanged, so callers keep their own error handling.
 */
export async function withRetry<T>(
  operation: (attempt: number, signal?: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 250, maxDelayMs = 4000, maxRetryAfterMs = 10_000, signal } = options;
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted();

    try {
      return await operation(attempt, signal);
    } catch (error) {
      const failure = classifyFailure(error);
      if (!failure.retryable || attempt >= maxAttempts) {
        throw error;
      }
      if (failure.retryAfterMs !== undefined && failure.retryAfterMs > maxRetryAfterMs) {
        throw error;
      }

      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = failure.retryAfterMs ?? Math.round(backoff * (1 + 0.25 * random()));
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}
