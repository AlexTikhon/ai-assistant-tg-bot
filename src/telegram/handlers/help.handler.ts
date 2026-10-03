import type { Context } from "telegraf";
import { messages } from "../ui/messages.js";

/** Sends the static command reference. */
export async function helpHandler(ctx: Context) {
  await ctx.reply(messages.help);
}
