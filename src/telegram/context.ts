import type { Context } from "telegraf";
import { ValidationError } from "../shared/errors.js";

/** Telegram user id as the string used for ownership everywhere else. Never returns "undefined". */
export function requireUserId(ctx: Context) {
  const id = ctx.from?.id;
  if (typeof id !== "number") {
    throw new ValidationError("I could not identify you from this message.");
  }
  return String(id);
}

/** Text of the incoming message, or "" for non-text messages. */
export function getMessageText(ctx: Context) {
  const message = ctx.message;
  return message && "text" in message ? message.text.trim() : "";
}

/** Whether the text is that command (also `/command@BotName`), with or without arguments. */
export function hasCommand(text: string | undefined, command: string) {
  return text !== undefined && new RegExp(`^/${command}(?:@\\w+)?(?:\\s|$)`, "i").test(text.trim());
}

/** The caption a user attached to a file, or undefined. */
export function getCaption(ctx: Context) {
  const message = ctx.message;
  return message && "caption" in message ? message.caption?.trim() : undefined;
}

/** `/askdoc <documentId> <question>`: both parts, or undefined when the id or the question is missing. */
export function parseAskDocArgs(text: string) {
  const match = /^(\S+)\s+([\s\S]+)$/.exec(parseCommandArgs(text, "askdoc"));
  return match ? { documentId: match[1], question: match[2] } : undefined;
}

/**
 * Returns what follows `/command` (also `/command@BotName`), trimmed.
 * Returns "" when the text is not that command.
 */
export function parseCommandArgs(text: string, command: string) {
  const match = new RegExp(`^/${command}(?:@\\w+)?(?:\\s+([\\s\\S]*))?$`, "i").exec(text.trim());
  return match?.[1]?.trim() ?? "";
}
