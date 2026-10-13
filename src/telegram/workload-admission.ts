import type { Context, MiddlewareFn } from "telegraf";
import { OverloadedError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { onOperationDrained, throwIfCancelled } from "../shared/operation.js";
import type { WorkloadLimiter } from "../shared/workload-limiter.js";
import { isCommandText, requireUserId } from "./context.js";

type Log = Pick<typeof logger, "warn">;
const defaultLog = logger.child({ component: "telegram" });

/**
 * Bounded admission for the handlers that start expensive work (downloads, PDF extraction, transcription, embeddings, generation).
 * It sits after the operation scope and the rate check, so it only ever sees updates that were claimed and are within the user's
 * rate limit, and in front of the handler that does the work. A request that does not fit gets an immediate OverloadedError (shown
 * by the error boundary; the update claim records it as a handled rejection, so a replay of the same update stays suppressed) and
 * nothing runs: no download, no provider call, no mutation. There is no waiting queue.
 *
 * One lease covers the whole handler. It is released when the update's OPERATION has drained - the handler has settled AND every
 * provider call it started has settled, even one that ignores cancellation - not when the deadline answered the user. A timed-out
 * request therefore keeps its slot for as long as its work really occupies the process. (Outside an operation scope, as in unit
 * tests, the lease ends when the handler settles.)
 *
 * `skipCommands` is for the plain-text handler, which ignores unknown `/commands` and so must not take capacity for them.
 */
export function createWorkloadAdmissionMiddleware(
  limiter: WorkloadLimiter,
  options: { skipCommands?: boolean; log?: Log } = {},
): MiddlewareFn<Context> {
  const log = options.log ?? defaultLog;

  return async (ctx, next) => {
    if (options.skipCommands && isCommandText(ctx)) {
      await next();
      return;
    }

    const userKey = requireUserId(ctx);
    // Shutdown or a deadline may already have cancelled this update: no new work is admitted for it.
    throwIfCancelled();

    const admission = limiter.tryAcquire(userKey);
    if (!admission.admitted) {
      // Which bound and how many are active: counts only, never a user id or any content.
      log.warn({ category: "workload-rejected", scope: admission.scope, active: limiter.activeCount }, "Expensive request refused: the bot is at capacity");
      throw new OverloadedError();
    }

    const { lease } = admission;
    if (onOperationDrained(lease.release)) {
      await next();
      return;
    }
    try {
      await next();
    } finally {
      lease.release();
    }
  };
}
