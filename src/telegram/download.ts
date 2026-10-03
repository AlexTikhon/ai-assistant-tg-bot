import type { Context } from "telegraf";
import { ExternalServiceError, ValidationError } from "../shared/errors.js";

const DOWNLOAD_FAILED = "I could not download that file from Telegram. Please try again.";

export type DownloadLimits = {
  maxBytes: number;
  timeoutMs: number;
};

export function tooLargeError(maxBytes: number) {
  return new ValidationError(`The file is too large. The limit is ${Math.round((maxBytes / (1024 * 1024)) * 10) / 10} MB.`);
}

/**
 * Downloads a file the user sent to the bot into memory.
 *
 * Bounded in time (AbortSignal) and in size: the declared Content-Length is checked up front and
 * the body is counted while streaming, so an oversized file is never fully buffered.
 */
export async function downloadTelegramFile(ctx: Context, fileId: string, limits: DownloadLimits) {
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    const response = await fetch(link, { signal: AbortSignal.timeout(limits.timeoutMs) });

    if (!response.ok) {
      throw new Error(`Telegram file download failed with status ${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > limits.maxBytes) {
      await response.body?.cancel();
      throw tooLargeError(limits.maxBytes);
    }

    return await readBody(response, limits.maxBytes);
  } catch (error) {
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
      throw tooLargeError(maxBytes);
    }
    parts.push(part);
  }

  return Buffer.concat(parts);
}
