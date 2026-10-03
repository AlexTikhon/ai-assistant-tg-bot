import type { Context } from "telegraf";
import type { AnswerQuestionUseCase } from "../../application/use-cases/answer-question.use-case.js";
import { withChatAction } from "../chat-action.js";
import { getMessageText, parseCommandArgs, requireUserId } from "../context.js";
import { replyLongText } from "../reply.js";
import { formatAnswer } from "../ui/format.js";
import { messages } from "../ui/messages.js";

/** Shared by `/ask`, plain-text questions and transcribed voice messages. */
export async function replyWithAnswer(ctx: Context, answerQuestion: AnswerQuestionUseCase, question: string) {
  if (!question.trim()) {
    await ctx.reply(messages.askUsage);
    return;
  }

  const userId = requireUserId(ctx);
  const result = await withChatAction(ctx, "typing", () => answerQuestion.execute({ userId, question }));
  await replyLongText(ctx, formatAnswer(result));
}

/** `/ask <question>` */
export function createAskHandler(answerQuestion: AnswerQuestionUseCase) {
  return (ctx: Context) => replyWithAnswer(ctx, answerQuestion, parseCommandArgs(getMessageText(ctx), "ask"));
}

/** Any non-command text message is treated as a question. */
export function createTextHandler(answerQuestion: AnswerQuestionUseCase) {
  return async (ctx: Context) => {
    const text = getMessageText(ctx);
    if (!text || text.startsWith("/")) {
      return;
    }

    await replyWithAnswer(ctx, answerQuestion, text);
  };
}
