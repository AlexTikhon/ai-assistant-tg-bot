import type { Context, MiddlewareFn } from "telegraf";
import { AppError, ExternalServiceError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { newRequestId, runWithRequestId } from "../shared/request-context.js";

const log = logger.child({ component: "telegram" });

const GENERIC_ERROR_MESSAGE = "Something went wrong while processing your request.";

/**
 * Gives every update a short opaque request id for the whole time it is handled, so all log lines of one update
 * (handler, retrieval, generation, ingestion) can be correlated. Never shown to users in normal replies.
 */
export const requestContext: MiddlewareFn<Context> = (_ctx, next) => runWithRequestId(newRequestId(), () => next());

/** Logs how long each update took. Never logs message content. */
export const requestLogger: MiddlewareFn<Context> = async (ctx, next) => {
  const startedAt = Date.now();
  try {
    await next();
  } finally {
    log.info(
      { updateType: ctx.updateType, userId: ctx.from?.id, durationMs: Date.now() - startedAt },
      "Update handled",
    );
  }
};

/**
 * Turns failures into safe replies: AppError messages are written for users and shown as is;
 * everything else (SQLite, filesystem, SDK errors...) is logged and replaced by a generic message.
 */
export const errorBoundary: MiddlewareFn<Context> = async (ctx, next) => {
  try {
    await next();
  } catch (error) {
    const context = { err: error, updateType: ctx.updateType, userId: ctx.from?.id };

    if (error instanceof ExternalServiceError || !(error instanceof AppError)) {
      log.error(context, "Update failed");
    } else {
      log.warn({ ...context, code: error.code }, "Update rejected");
    }

    const reply = error instanceof AppError ? error.message : GENERIC_ERROR_MESSAGE;
    await ctx.reply(reply).catch((replyError) => log.error({ err: replyError }, "Could not send error reply"));
  }
};

/** Last line of defense (e.g. handler timeouts): log, never rethrow - Telegraf would crash the bot. */
export function logUnhandledError(error: unknown, ctx: Context) {
  log.error({ err: error, updateType: ctx.updateType, userId: ctx.from?.id }, "Unhandled bot error");
}
