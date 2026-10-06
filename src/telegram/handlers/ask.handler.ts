import type { Context } from "telegraf";
import type { AnswerQuestionUseCase } from "../../application/use-cases/answer-question.use-case.js";
import { withChatAction } from "../chat-action.js";
import { currentRequestId } from "../../shared/request-context.js";
import { getMessageText, parseAskDocArgs, parseCommandArgs, requireUserId } from "../context.js";
import { replyLongText } from "../reply.js";
import { formatAnswer } from "../ui/format.js";
import { feedbackKeyboard } from "../ui/keyboards.js";
import { messages } from "../ui/messages.js";

export type AnswerReplyOptions = {
  /** Put thumbs-up/down buttons under the answer (they carry the answer's request id). */
  feedbackButtons?: boolean;
};

type ReplyWithAnswerOptions = AnswerReplyOptions & {
  /** Search only this one of the sender's documents instead of the whole knowledge base. */
  documentId?: string;
};

/** Shared by `/ask`, `/askdoc`, plain-text questions and transcribed voice messages. */
export async function replyWithAnswer(
  ctx: Context,
  answerQuestion: AnswerQuestionUseCase,
  question: string,
  options: ReplyWithAnswerOptions = {},
) {
  if (!question.trim()) {
    await ctx.reply(messages.askUsage);
    return;
  }

  const userId = requireUserId(ctx);
  const result = await withChatAction(ctx, "typing", () => answerQuestion.execute({ userId, question, documentId: options.documentId }));
  const requestId = currentRequestId();
  await replyLongText(ctx, formatAnswer(result), options.feedbackButtons && requestId ? feedbackKeyboard(requestId) : undefined);
}

/** `/ask <question>` */
export function createAskHandler(answerQuestion: AnswerQuestionUseCase, options: AnswerReplyOptions = {}) {
  return (ctx: Context) => replyWithAnswer(ctx, answerQuestion, parseCommandArgs(getMessageText(ctx), "ask"), options);
}

/** `/askdoc <documentId> <question>`: like `/ask`, but only the given document is searched. */
export function createAskDocHandler(answerQuestion: AnswerQuestionUseCase, options: AnswerReplyOptions = {}) {
  return async (ctx: Context) => {
    const args = parseAskDocArgs(getMessageText(ctx));
    if (!args) {
      await ctx.reply(messages.askDocUsage);
      return;
    }
    await replyWithAnswer(ctx, answerQuestion, args.question, { ...options, documentId: args.documentId });
  };
}

/** Any non-command text message is treated as a question. */
export function createTextHandler(answerQuestion: AnswerQuestionUseCase, options: AnswerReplyOptions = {}) {
  return async (ctx: Context) => {
    const text = getMessageText(ctx);
    if (!text || text.startsWith("/")) {
      return;
    }

    await replyWithAnswer(ctx, answerQuestion, text, options);
  };
}
