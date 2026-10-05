import type { Telegraf } from "telegraf";
import type { RateLimiter } from "../shared/rate-limiter.js";
import type { SpeechToText } from "../application/ports/speech-to-text.js";
import type { AnswerQuestionUseCase } from "../application/use-cases/answer-question.use-case.js";
import type { DeleteDocumentUseCase } from "../application/use-cases/delete-document.use-case.js";
import type { GetDocumentUseCase } from "../application/use-cases/get-document.use-case.js";
import type { IngestDocumentUseCase } from "../application/use-cases/ingest-document.use-case.js";
import type { ListDocumentsUseCase } from "../application/use-cases/list-documents.use-case.js";
import type { RecordFeedbackUseCase } from "../application/use-cases/record-feedback.use-case.js";
import type { ReplaceDocumentUseCase } from "../application/use-cases/replace-document.use-case.js";
import type { SummarizeDocumentUseCase } from "../application/use-cases/summarize-document.use-case.js";
import type { DownloadLimits } from "./download.js";
import { createAskHandler, createTextHandler } from "./handlers/ask.handler.js";
import { createDeleteHandler } from "./handlers/delete.handler.js";
import { createDocHandler } from "./handlers/doc.handler.js";
import { createFeedbackHandler, FEEDBACK_PATTERN } from "./handlers/feedback.handler.js";
import { helpHandler } from "./handlers/help.handler.js";
import { createListHandler } from "./handlers/list.handler.js";
import { createReplaceHelpHandler } from "./handlers/replace.handler.js";
import { startHandler } from "./handlers/start.handler.js";
import { createSummaryHandler } from "./handlers/summary.handler.js";
import { createUploadHandler } from "./handlers/upload.handler.js";
import { createVoiceHandler } from "./handlers/voice.handler.js";
import { errorBoundary, logUnhandledError, privateChatOnly, requestContext, requestLogger } from "./middleware.js";
import { createRateLimitMiddleware } from "./rate-limit.js";
import { Operations } from "../shared/operation.js";
import { createOperationMiddleware } from "./operation.js";

export type TelegramDependencies = {
  ingestDocument: IngestDocumentUseCase;
  replaceDocument: ReplaceDocumentUseCase;
  getDocument: GetDocumentUseCase;
  answerQuestion: AnswerQuestionUseCase;
  listDocuments: ListDocumentsUseCase;
  summarizeDocument: SummarizeDocumentUseCase;
  deleteDocument: DeleteDocumentUseCase;
  speechToText: SpeechToText;
  downloadLimits: DownloadLimits;
  /** Per-user limit shared by every handler that calls OpenAI. */
  rateLimiter: RateLimiter;
  /** When present, answers get thumbs-up/down buttons and their presses are recorded. Off by default. */
  feedback?: RecordFeedbackUseCase;
  operations?: Operations;
};

/** Routes Telegram updates to handlers. Contains no business logic and creates no dependencies. */
export function registerHandlers(bot: Telegraf, deps: TelegramDependencies, timeoutMs = 300_000) {
  bot.use(requestContext, requestLogger, errorBoundary, privateChatOnly, createOperationMiddleware(deps.operations ?? new Operations(), timeoutMs));
  bot.catch(logUnhandledError);

  // Only handlers that cost OpenAI money are limited; /list, /delete and /help stay free.
  const limited = createRateLimitMiddleware(deps.rateLimiter);
  const limitedText = createRateLimitMiddleware(deps.rateLimiter, { skipCommands: true });

  bot.start(startHandler);
  bot.command("help", helpHandler);
  bot.command("list", createListHandler(deps.listDocuments));
  bot.command("doc", createDocHandler(deps.getDocument));
  bot.command("replace", createReplaceHelpHandler());
  const replyOptions = { feedbackButtons: deps.feedback !== undefined };
  bot.command("ask", limited, createAskHandler(deps.answerQuestion, replyOptions));
  bot.command("summary", limited, createSummaryHandler(deps.summarizeDocument));
  bot.command("delete", createDeleteHandler(deps.deleteDocument));

  bot.on("document", limited, createUploadHandler(deps.ingestDocument, deps.replaceDocument, deps.downloadLimits));
  bot.on("voice", limited, createVoiceHandler(deps.speechToText, deps.answerQuestion, deps.downloadLimits, replyOptions));
  bot.on("text", limitedText, createTextHandler(deps.answerQuestion, replyOptions));
  if (deps.feedback) {
    // Recording a rating costs nothing (no OpenAI call), so it is not rate limited.
    bot.action(FEEDBACK_PATTERN, createFeedbackHandler(deps.feedback));
  }
}
