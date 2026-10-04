import type { Context } from "telegraf";
import type { GetDocumentUseCase } from "../../application/use-cases/get-document.use-case.js";
import { getMessageText, parseCommandArgs, requireUserId } from "../context.js";
import { formatDocumentInfo } from "../ui/format.js";
import { messages } from "../ui/messages.js";

/** `/doc <documentId>` - details of one of the sender's documents. */
export function createDocHandler(getDocument: GetDocumentUseCase) {
  return async (ctx: Context) => {
    const documentId = parseCommandArgs(getMessageText(ctx), "doc");
    if (!documentId) {
      await ctx.reply(messages.docUsage);
      return;
    }

    await ctx.reply(formatDocumentInfo(await getDocument.execute(requireUserId(ctx), documentId)));
  };
}
