import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { registerHandlers } from "./register-handlers.js";
import type { TelegramDependencies } from "./register-handlers.js";

/**
 * Creates the Telegraf instance with all handlers registered. Does not touch the network.
 * `telegram` overrides the Bot API client's options; it exists so the adapter contract tests can point the real client at a local fake server.
 */
export function createBot(token: string, handlerTimeoutMs: number, deps: TelegramDependencies, telegram?: Partial<Telegraf.Options<Context>["telegram"]>) {
  // Telegraf's default handler timeout is 90s, too short for indexing a large PDF.
  const bot = new Telegraf(token, { handlerTimeout: handlerTimeoutMs, ...(telegram ? { telegram } : {}) });
  registerHandlers(bot, deps);
  return bot;
}
