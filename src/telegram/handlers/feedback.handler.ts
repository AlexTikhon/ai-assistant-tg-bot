import type { Context } from "telegraf";
import type { RecordFeedbackUseCase } from "../../application/use-cases/record-feedback.use-case.js";
import { requireUserId } from "../context.js";

/** "fb:g:<id>" (good) or "fb:b:<id>"; the id is the 8-hex-character request id of the answer. */
export const FEEDBACK_PATTERN = /^fb:([gb]):([0-9a-f]{8})$/;

/** The thumbs-up / thumbs-down buttons under an answer (see feedbackKeyboard). */
export function createFeedbackHandler(recordFeedback: RecordFeedbackUseCase) {
  return async (ctx: Context) => {
    const match = (ctx as Context & { match?: RegExpExecArray }).match;
    if (!match) {
      return;
    }

    try {
      await recordFeedback.execute({ userId: requireUserId(ctx), requestId: match[2], rating: match[1] === "g" ? "good" : "bad" });
      await ctx.answerCbQuery("Thanks for the feedback!");
      // One rating per answer from the keyboard: the buttons disappear. Not worth failing over if Telegram refuses.
      await ctx.editMessageReplyMarkup(undefined).catch(() => undefined);
    } catch (error) {
      // Always close the button's loading spinner; the error boundary logs the failure and replies generically.
      await ctx.answerCbQuery().catch(() => undefined);
      throw error;
    }
  };
}
