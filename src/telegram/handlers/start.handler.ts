import type { Context } from "telegraf";
import { mainKeyboard } from "../ui/keyboards.js";
import { messages } from "../ui/messages.js";

/** Sends the welcome message and the main reply keyboard. */
export async function startHandler(ctx: Context) {
  await ctx.reply(messages.start, { reply_markup: mainKeyboard() });
}
