import type { Context } from "telegraf";
import type { SummarizeDocumentUseCase } from "../../application/use-cases/summarize-document.use-case.js";
import { withChatAction } from "../chat-action.js";
import { getMessageText, parseCommandArgs, requireUserId } from "../context.js";
import { replyLongText } from "../reply.js";
import { formatSummary } from "../ui/format.js";
import { messages } from "../ui/messages.js";

/** `/summary <documentId>` */
export function createSummaryHandler(summarizeDocument: SummarizeDocumentUseCase) {
  return async (ctx: Context) => {
    const documentId = parseCommandArgs(getMessageText(ctx), "summary");
    if (!documentId) {
      await ctx.reply(messages.summaryUsage);
      return;
    }

    const userId = requireUserId(ctx);
    const result = await withChatAction(ctx, "typing", () => summarizeDocument.execute(userId, documentId));
    await replyLongText(ctx, formatSummary(result.document.fileName, result.summary));
  };
}
