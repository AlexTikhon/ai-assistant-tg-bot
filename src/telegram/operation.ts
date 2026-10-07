import type { Context, MiddlewareFn } from "telegraf";
import type { Operations } from "../shared/operation.js";
import { OperationCancelledError } from "../shared/operation.js";

const cancelled = new WeakMap<Context, OperationCancelledError>();

/** Set when this update's operation was cancelled (deadline or shutdown): the middleware answers and resolves, so this is how outer layers learn it. */
export const cancellationKind = (ctx: Context) => cancelled.get(ctx)?.kind;

/** A safe deadline reply is sent outside the cancelled scope; all late handler replies are refused. */
export function createOperationMiddleware(operations: Operations, timeoutMs: number): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const reply = ctx.reply.bind(ctx);
    const answerCallback = ctx.answerCbQuery.bind(ctx);
    try {
      await operations.run(timeoutMs, async (signal) => {
        ctx.reply = async (...args) => { signal.throwIfAborted(); return reply(...args); };
        ctx.answerCbQuery = async (...args) => { signal.throwIfAborted(); return answerCallback(...args); };
        const chatAction = ctx.sendChatAction.bind(ctx);
        ctx.sendChatAction = async (...args) => { signal.throwIfAborted(); return chatAction(...args); };
        const editMarkup = ctx.editMessageReplyMarkup.bind(ctx);
        ctx.editMessageReplyMarkup = async (...args) => { signal.throwIfAborted(); return editMarkup(...args); };
        await next();
      });
    } catch (error) {
      if (!(error instanceof OperationCancelledError)) throw error;
      cancelled.set(ctx, error);
      // One best-effort error response. A failed delivery must not fall through to a second response.
      await (ctx.callbackQuery ? answerCallback(error.message) : reply(error.message)).catch(() => undefined);
    }
  };
}
