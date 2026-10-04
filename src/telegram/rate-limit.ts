import type { Context, MiddlewareFn } from "telegraf";
import type { RateLimiter } from "../shared/rate-limiter.js";
import { getMessageText, requireUserId } from "./context.js";

/**
 * Middleware for the handlers that cost money (questions, summaries, uploads, voice): each call
 * consumes one slot of the sender's rate limit, and a user over the limit gets a friendly
 * RateLimitError (shown by the error boundary) instead of triggering more OpenAI calls.
 *
 * `skipCommands` is for the plain-text handler, which ignores unknown `/commands` and so must not charge for them.
 */
export function createRateLimitMiddleware(
  limiter: RateLimiter,
  options: { skipCommands?: boolean } = {},
): MiddlewareFn<Context> {
  return async (ctx, next) => {
    if (!(options.skipCommands && getMessageText(ctx).startsWith("/"))) {
      limiter.assertAllowed(requireUserId(ctx));
    }
    await next();
  };
}
