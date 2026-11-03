import type { Context } from "telegraf";
import { safeCutIndex } from "../shared/utils/text.js";
import { boundOutput, OUTPUT_TRUNCATED_NOTICE } from "../shared/output-budget.js";

/** Telegram rejects messages above 4096 characters; stay a little below to be safe. */
export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_REPLY_CHARS = 24_000;
export const MAX_REPLY_MESSAGES = 8;

/** Preferred split points, best first. A boundary in the first half is not worth the tiny message it leaves. */
const BOUNDARIES = ["\n\n", "\n", ". ", " "];

/**
 * Splits text into parts of at most `limit` characters, preferring paragraph, line, sentence and
 * word boundaries, and never cutting through a surrogate pair (e.g. an emoji).
 */
export function splitMessage(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (!Number.isInteger(limit) || limit < 2) throw new RangeError("Message limit must be an integer of at least 2");
  const parts: string[] = [];
  let rest = text.trim();

  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = 0;

    for (const boundary of BOUNDARIES) {
      const index = window.lastIndexOf(boundary);
      if (index > limit / 2) {
        cut = index + boundary.length;
        break;
      }
    }
    if (cut === 0) {
      cut = safeCutIndex(rest, limit);
    }

    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }

  if (rest.length > 0) {
    parts.push(rest);
  }

  return parts;
}

/** Bounded, sequential delivery. No retries; `extra` goes on the last part actually sent. */
export async function replyLongText(ctx: Context, text: string, extra?: Parameters<Context["reply"]>[1]) {
  const parts = splitMessage(boundOutput(text, MAX_REPLY_CHARS));
  if (parts.length > MAX_REPLY_MESSAGES) {
    parts.length = MAX_REPLY_MESSAGES;
    const last = parts.length - 1;
    // A part that itself fits still needs the notice when subsequent parts were dropped.
    const remainingChars = MAX_REPLY_CHARS - parts.slice(0, last).reduce((total, part) => total + part.length, 0);
    parts[last] = boundOutput(parts[last] + OUTPUT_TRUNCATED_NOTICE, Math.min(MAX_MESSAGE_LENGTH, remainingChars));
  }
  for (const [index, part] of parts.entries()) {
    await (index === parts.length - 1 && extra ? ctx.reply(part, extra) : ctx.reply(part));
  }
}
