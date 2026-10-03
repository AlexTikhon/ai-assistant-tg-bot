import type { Context } from "telegraf";
import type { ListDocumentsUseCase } from "../../application/use-cases/list-documents.use-case.js";
import { requireUserId } from "../context.js";
import { replyLongText } from "../reply.js";
import { formatDocumentList } from "../ui/format.js";
import { messages } from "../ui/messages.js";

/** `/list` - the current user's indexed documents. */
export function createListHandler(listDocuments: ListDocumentsUseCase) {
  return async (ctx: Context) => {
    const documents = await listDocuments.execute(requireUserId(ctx));

    if (documents.length === 0) {
      await ctx.reply(messages.emptyDocuments);
      return;
    }

    await replyLongText(ctx, formatDocumentList(documents));
  };
}
