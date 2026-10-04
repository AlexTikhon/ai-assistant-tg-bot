import type { Context } from "telegraf";
import type { AnswerQuestionUseCase } from "../../application/use-cases/answer-question.use-case.js";
import { withChatAction } from "../chat-action.js";
import { currentRequestId } from "../../shared/request-context.js";
import { getMessageText, parseCommandArgs, requireUserId } from "../context.js";
import { replyLongText } from "../reply.js";
import { formatAnswer } from "../ui/format.js";
import { feedbackKeyboard } from "../ui/keyboards.js";
import { messages } from "../ui/messages.js";

export type AnswerReplyOptions = {
  /** Put thumbs-up/down buttons under the answer (they carry the answer's request id). */
  feedbackButtons?: boolean;
};

/** Shared by `/ask`, plain-text questions and transcribed voice messages. */
export async function replyWithAnswer(
  ctx: Context,
  answerQuestion: AnswerQuestionUseCase,
  question: string,
  options: AnswerReplyOptions = {},
) {
  if (!question.trim()) {
    await ctx.reply(messages.askUsage);
    return;
  }

  const userId = requireUserId(ctx);
  const result = await withChatAction(ctx, "typing", () => answerQuestion.execute({ userId, question }));
  const requestId = currentRequestId();
  await replyLongText(ctx, formatAnswer(result), options.feedbackButtons && requestId ? feedbackKeyboard(requestId) : undefined);
}

/** `/ask <question>` */
export function createAskHandler(answerQuestion: AnswerQuestionUseCase, options: AnswerReplyOptions = {}) {
  return (ctx: Context) => replyWithAnswer(ctx, answerQuestion, parseCommandArgs(getMessageText(ctx), "ask"), options);
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
