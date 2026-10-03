import type { Context } from "telegraf";
import type { IngestDocumentUseCase } from "../../application/use-cases/ingest-document.use-case.js";
import { isSupportedFileName } from "../../core/document.js";
import { withChatAction } from "../chat-action.js";
import { requireUserId } from "../context.js";
import { downloadTelegramFile, tooLargeError } from "../download.js";
import type { DownloadLimits } from "../download.js";
import { formatIngestResult } from "../ui/format.js";
import { messages } from "../ui/messages.js";

/** A document message: download it (within limits) and run it through ingestion. */
export function createUploadHandler(ingestDocument: IngestDocumentUseCase, limits: DownloadLimits) {
  return async (ctx: Context) => {
    const message = ctx.message;
    const document = message && "document" in message ? message.document : undefined;

    if (!document?.file_name || !isSupportedFileName(document.file_name)) {
      await ctx.reply(messages.unsupportedFile);
      return;
    }
    // Cheap checks first: reject before downloading, parsing or embedding anything.
    if (document.file_size !== undefined && document.file_size > limits.maxBytes) {
      throw tooLargeError(limits.maxBytes);
    }

    const userId = requireUserId(ctx);
    const fileName = document.file_name;

    const result = await withChatAction(ctx, "typing", async () => {
      const data = await downloadTelegramFile(ctx, document.file_id, limits);
      return ingestDocument.execute({
        userId,
        fileName,
        mimeType: document.mime_type ?? "application/octet-stream",
        data,
      });
    });

    await ctx.reply(formatIngestResult(result));
  };
}
