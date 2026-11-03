import type { Context, MiddlewareFn } from "telegraf";
import type { Operations } from "../shared/operation.js";
import { OperationCancelledError, operationStep } from "../shared/operation.js";
import { withTelegramSignal } from "./api-cancellation.js";

const cancelled = new WeakMap<Context, OperationCancelledError>();
const attempted = new WeakSet<Context>();
const TELEGRAM_REQUEST_TIMEOUT_MS = 10_000;
export const hasDeliveryAttempt = (ctx: Context) => attempted.has(ctx);

/** Set when this update's operation was cancelled (deadline or shutdown): the middleware answers and resolves, so this is how outer layers learn it. */
export const cancellationKind = (ctx: Context) => cancelled.get(ctx)?.kind;

/** A safe deadline reply is sent outside the cancelled scope; all late handler replies are refused. */
export function createOperationMiddleware(operations: Operations, timeoutMs: number): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const reply = ctx.reply.bind(ctx);
    const answerCallback = ctx.answerCbQuery.bind(ctx);
    const rawApi = ctx.telegram.callApi.bind(ctx.telegram);
    try {
      await operations.run(timeoutMs, async (signal) => {
        const guardedApi = (...[method, payload, options]: Parameters<typeof rawApi>) => {
          signal.throwIfAborted();
          if (["sendMessage", "answerCallbackQuery", "editMessageReplyMarkup"].includes(method)) attempted.add(ctx);
          const transportDeadline = AbortSignal.any([signal, AbortSignal.timeout(TELEGRAM_REQUEST_TIMEOUT_MS)]);
          return operationStep(() => withTelegramSignal(transportDeadline, options?.signal,
            (transportSignal) => rawApi(method, payload, { ...options, signal: transportSignal })), signal);
        };
        ctx.telegram.callApi = guardedApi as typeof rawApi;
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
      // A started delivery may already have been accepted. Never follow it with a conflicting timeout or retry.
      if (hasDeliveryAttempt(ctx)) return;
      await withTelegramSignal<unknown>(AbortSignal.timeout(5000), undefined, (signal) => ctx.callbackQuery
        ? rawApi("answerCallbackQuery", { callback_query_id: ctx.callbackQuery.id, text: error.message }, { signal })
        : rawApi("sendMessage", { chat_id: ctx.chat!.id, text: error.message }, { signal })).catch(() => undefined);
    }
  };
}
