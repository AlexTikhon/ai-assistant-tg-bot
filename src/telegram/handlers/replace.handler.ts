import type { Context } from "telegraf";
import { messages } from "../ui/messages.js";

/**
 * `/replace` as a plain command (no file attached): replacement needs the new file, so this only explains how:
 * send the file with the caption `/replace <documentId>`. The actual work is in the upload handler.
 */
export function createReplaceHelpHandler() {
  return async (ctx: Context) => {
    await ctx.reply(messages.replaceUsage);
  };
}
