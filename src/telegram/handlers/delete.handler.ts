import type { Context } from "telegraf";
import type { DeleteDocumentUseCase } from "../../application/use-cases/delete-document.use-case.js";
import { getMessageText, parseCommandArgs, requireUserId } from "../context.js";
import { messages } from "../ui/messages.js";

/** `/delete <documentId>` */
export function createDeleteHandler(deleteDocument: DeleteDocumentUseCase) {
  return async (ctx: Context) => {
    const documentId = parseCommandArgs(getMessageText(ctx), "delete");
    if (!documentId) {
      await ctx.reply(messages.deleteUsage);
      return;
    }

    await deleteDocument.execute(requireUserId(ctx), documentId);
    await ctx.reply(`Deleted document ${documentId}.`);
  };
}
