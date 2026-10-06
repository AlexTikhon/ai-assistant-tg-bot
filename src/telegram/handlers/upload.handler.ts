import type { Context } from "telegraf";
import type { IngestDocumentUseCase } from "../../application/use-cases/ingest-document.use-case.js";
import type { ReplaceDocumentUseCase } from "../../application/use-cases/replace-document.use-case.js";
import { isSupportedFileName } from "../../core/document.js";
import { withChatAction } from "../chat-action.js";
import { getCaption, hasCommand, parseCommandArgs, requireUserId } from "../context.js";
import { downloadTelegramFile } from "../download.js";
import { fileTooLargeError } from "../../shared/errors.js";
import type { DownloadLimits } from "../download.js";
import { formatIngestResult } from "../ui/format.js";
import { messages } from "../ui/messages.js";

type Download = typeof downloadTelegramFile;

/**
 * A document message: download it (within limits) and either ingest it as a new document or - when the
 * caption is `/replace <documentId>` - replace that document of the sender. Replacement is only ever
 * triggered by that explicit caption, never by a file name.
 */
export function createUploadHandler(
  ingestDocument: IngestDocumentUseCase,
  replaceDocument: ReplaceDocumentUseCase,
  limits: DownloadLimits,
  download: Download = downloadTelegramFile,
) {
  return async (ctx: Context) => {
    const message = ctx.message;
    const document = message && "document" in message ? message.document : undefined;

    if (!document?.file_name || !isSupportedFileName(document.file_name)) {
      await ctx.reply(messages.unsupportedFile);
      return;
    }
    // Cheap checks first: reject before downloading, parsing or embedding anything.
    if (document.file_size !== undefined && document.file_size > limits.maxBytes) {
      throw fileTooLargeError(limits.maxBytes);
    }

    const caption = getCaption(ctx);
    const replaceId = hasCommand(caption, "replace") ? parseCommandArgs(caption!, "replace") : undefined;
    if (replaceId === "") {
      await ctx.reply(messages.replaceUsage);
      return;
    }

    const userId = requireUserId(ctx);
    const fileName = document.file_name;

    const result = await withChatAction(ctx, "typing", async () => {
      const data = await download(ctx, document.file_id, limits);
      const file = { userId, fileName, mimeType: document.mime_type ?? "application/octet-stream", data };
      return replaceId === undefined
        ? ingestDocument.execute(file)
        : replaceDocument.execute({ ...file, documentId: replaceId });
    });

    await ctx.reply(formatIngestResult(result));
  };
}
