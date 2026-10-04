import type { Telegraf } from "telegraf";
import type { RateLimiter } from "../shared/rate-limiter.js";
import type { SpeechToText } from "../application/ports/speech-to-text.js";
import type { AnswerQuestionUseCase } from "../application/use-cases/answer-question.use-case.js";
import type { DeleteDocumentUseCase } from "../application/use-cases/delete-document.use-case.js";
import type { IngestDocumentUseCase } from "../application/use-cases/ingest-document.use-case.js";
import type { ListDocumentsUseCase } from "../application/use-cases/list-documents.use-case.js";
import type { SummarizeDocumentUseCase } from "../application/use-cases/summarize-document.use-case.js";
import type { DownloadLimits } from "./download.js";
import { createAskHandler, createTextHandler } from "./handlers/ask.handler.js";
import { createDeleteHandler } from "./handlers/delete.handler.js";
import { helpHandler } from "./handlers/help.handler.js";
import { createListHandler } from "./handlers/list.handler.js";
import { startHandler } from "./handlers/start.handler.js";
import { createSummaryHandler } from "./handlers/summary.handler.js";
import { createUploadHandler } from "./handlers/upload.handler.js";
import { createVoiceHandler } from "./handlers/voice.handler.js";
import { errorBoundary, logUnhandledError, requestLogger } from "./middleware.js";
import { createRateLimitMiddleware } from "./rate-limit.js";

export type TelegramDependencies = {
  ingestDocument: IngestDocumentUseCase;
  answerQuestion: AnswerQuestionUseCase;
  listDocuments: ListDocumentsUseCase;
  summarizeDocument: SummarizeDocumentUseCase;
  deleteDocument: DeleteDocumentUseCase;
  speechToText: SpeechToText;
  downloadLimits: DownloadLimits;
  /** Per-user limit shared by every handler that calls OpenAI. */
  rateLimiter: RateLimiter;
};

/** Routes Telegram updates to handlers. Contains no business logic and creates no dependencies. */
export function registerHandlers(bot: Telegraf, deps: TelegramDependencies) {
  bot.use(requestLogger, errorBoundary);
  bot.catch(logUnhandledError);

  // Only handlers that cost OpenAI money are limited; /list, /delete and /help stay free.
  const limited = createRateLimitMiddleware(deps.rateLimiter);
  const limitedText = createRateLimitMiddleware(deps.rateLimiter, { skipCommands: true });

  bot.start(startHandler);
  bot.command("help", helpHandler);
  bot.command("list", createListHandler(deps.listDocuments));
  bot.command("ask", limited, createAskHandler(deps.answerQuestion));
  bot.command("summary", limited, createSummaryHandler(deps.summarizeDocument));
  bot.command("delete", createDeleteHandler(deps.deleteDocument));

  bot.on("document", limited, createUploadHandler(deps.ingestDocument, deps.downloadLimits));
  bot.on("voice", limited, createVoiceHandler(deps.speechToText, deps.answerQuestion, deps.downloadLimits));
  bot.on("text", limitedText, createTextHandler(deps.answerQuestion));
}
