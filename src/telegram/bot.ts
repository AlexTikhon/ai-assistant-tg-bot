import { Telegraf } from "telegraf";
import { registerHandlers } from "./register-handlers.js";
import type { TelegramDependencies } from "./register-handlers.js";

/** Creates the Telegraf instance with all handlers registered. Does not touch the network. */
export function createBot(token: string, handlerTimeoutMs: number, deps: TelegramDependencies) {
  // Telegraf's default handler timeout is 90s, too short for indexing a large PDF.
  const bot = new Telegraf(token, { handlerTimeout: handlerTimeoutMs });
  registerHandlers(bot, deps);
  return bot;
}
