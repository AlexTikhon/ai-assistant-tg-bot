import type { Context } from "telegraf";
import { ExternalServiceError, fileTooLargeError, ValidationError } from "../shared/errors.js";
import { HttpStatusError, parseRetryAfter, withRetry } from "../shared/retry.js";
import type { RetryOptions } from "../shared/retry.js";
import { operationSignal, operationStep } from "../shared/operation.js";

const DOWNLOAD_FAILED = "I could not download that file from Telegram. Please try again.";

export type DownloadLimits = {
  maxBytes: number;
  timeoutMs: number;
};

export type DownloadDependencies = {
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
};

/**
 * Downloads a file the user sent to the bot into memory.
 *
 * Bounded in time (AbortSignal) and in size: the declared Content-Length is checked up front and
 * the body is counted while streaming, so an oversized file is never fully buffered. A transient failure
 * (429, 5xx, network reset, timeout) is retried a bounded number of times with backoff - fetching a file is
 * idempotent and the user has not been answered yet, so a retry can never produce a duplicate reply. An
 * oversized file or a 4xx is final.
 */
export async function downloadTelegramFile(ctx: Context, fileId: string, limits: DownloadLimits, deps: DownloadDependencies = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const signal = operationSignal() ?? deps.retry?.signal;

  try {
    return await withRetry(async () => {
      const link = await operationStep(() => ctx.telegram.getFileLink(fileId), signal);
      const timeout = AbortSignal.timeout(limits.timeoutMs);
      const response = await fetchImpl(link, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new HttpStatusError(`Telegram file download failed with status ${response.status}`, {
          status: response.status,
          retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
        });
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (declaredLength > limits.maxBytes) {
        await response.body?.cancel();
        throw fileTooLargeError(limits.maxBytes);
      }

      return await operationStep(() => readBody(response, limits.maxBytes), signal);
    }, { ...deps.retry, signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ValidationError) {
      throw error;
    }
    throw new ExternalServiceError("telegram", { cause: error }, DOWNLOAD_FAILED);
  }
}

async function readBody(response: Response, maxBytes: number) {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const parts: Uint8Array[] = [];
  let total = 0;

  for await (const part of response.body) {
    total += part.byteLength;
    if (total > maxBytes) {
      throw fileTooLargeError(maxBytes);
    }
    parts.push(part);
  }

  return Buffer.concat(parts);
}
