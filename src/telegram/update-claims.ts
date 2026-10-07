import type { Context, MiddlewareFn } from "telegraf";
import type { UpdateClaimOutcome, UpdateClaimStore } from "../application/ports/update-claims.js";
import { AppError, ExternalServiceError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { OperationCancelledError } from "../shared/operation.js";
import { cancellationKind } from "./operation.js";

type Log = Pick<typeof logger, "info" | "warn" | "error">;
const defaultLog = logger.child({ component: "telegram" });

/** One bounded cleanup batch runs after every this many admitted claims (age-based: recent claims are never touched). */
const PURGE_EVERY_CLAIMS = 256;
const PURGE_BATCH = 500;
/** Startup removes what expired while the bot was down, in bounded batches. */
const STARTUP_PURGE_MAX_BATCHES = 20;

const ADMISSION_FAILED_MESSAGE = "The bot could not accept this request right now. Please try again in a moment.";

/**
 * Startup, bot application only: a claim still `running` belongs to a process that no longer exists, and nobody can tell which of its
 * external effects (OpenAI, Telegram, files) completed. It becomes `interrupted` and keeps suppressing that update. Then what expired
 * while the bot was down is removed. Assumes ONE live bot process per database: with two, this would interrupt the other's live claims.
 */
export function recoverUpdateClaims(store: UpdateClaimStore, log: Log = defaultLog) {
  const interrupted = store.recoverInterrupted();
  let purged = 0;
  for (let batch = 0; batch < STARTUP_PURGE_MAX_BATCHES; batch += 1) {
    const removed = store.purgeExpired(PURGE_BATCH);
    purged += removed;
    if (removed < PURGE_BATCH) break;
  }
  log.info({ interrupted, purged }, "Update claims recovered");
}

/**
 * Durable admission of Telegram updates: the (bot id, update id) of an accepted private update is claimed in one atomic SQLite step BEFORE
 * any rate limiting, routing, provider call, mutation or reply. Whoever loses the claim - a redelivery after a restart, a duplicate in the
 * same batch - does no business work at all (silently; only a callback gets an empty acknowledgement).
 *
 * This middleware alone writes the terminal state, once, from the actual outcome of the rest of the chain:
 *   - returned normally                         -> completed
 *   - threw a user-facing AppError (rate limit, not found, invalid input...) -> completed / rejected (a handled outcome, the reply was sent)
 *   - threw ExternalServiceError                -> failed / external
 *   - threw anything else                       -> failed / internal
 *   - the operation was cancelled (deadline or shutdown) -> interrupted / timeout | shutdown (the physical work may still be finishing:
 *     it can never reach this ledger again, because the claim is already terminal and finishing is fenced on `running`)
 * If the terminal write fails the claim stays `running`: still suppressing, and recovered to `interrupted` by the next startup.
 * A claim is never deleted to make an update retryable. If the claim itself cannot be written, nothing runs (fail closed).
 */
export function createUpdateClaimMiddleware(options: { store: UpdateClaimStore; log?: Log }): MiddlewareFn<Context> {
  const { store } = options;
  const log = options.log ?? defaultLog;
  let admitted = 0;

  return async (ctx, next) => {
    // The bot's public id (not its token: a rotated token is still the same bot) and Telegram's update id, exactly as received.
    const botId = ctx.botInfo?.id;
    // Typed as numbers, but Telegram data is not trusted: the store validates both at runtime and rejects anything else.
    const updateId = (ctx.update as { update_id?: unknown } | undefined)?.update_id as number;

    let claim;
    try {
      claim = store.claim(botId, updateId);
    } catch (error) {
      // Only a category and the SQLite error code: never the error text, never anything from the update.
      log.error({ category: "update-claim-failed", code: errorCode(error) }, "Could not claim the update; it is not processed");
      throw new AppError(ADMISSION_FAILED_MESSAGE, "UPDATE_ADMISSION_FAILED");
    }

    if (!claim.admitted) {
      log.info({ updateId, claimState: claim.state }, "Duplicate update suppressed");
      // The spinner of a button press must stop. A duplicate of a still-running update is left alone: the winner answers it once.
      if (ctx.callbackQuery && claim.state !== "running") await ctx.answerCbQuery().catch(() => undefined);
      return;
    }

    admitted += 1;
    if (admitted % PURGE_EVERY_CLAIMS === 0) purgeOneBatch(store, log);

    let outcome: UpdateClaimOutcome = { state: "completed" };
    try {
      await next();
      const cancelled = cancellationKind(ctx);
      if (cancelled) outcome = { state: "interrupted", category: cancelled };
    } catch (error) {
      outcome = outcomeOfError(error);
      throw error;
    } finally {
      finalize(store, log, botId, updateId, outcome);
    }
  };
}

function outcomeOfError(error: unknown): UpdateClaimOutcome {
  if (error instanceof OperationCancelledError) return { state: "interrupted", category: error.kind };
  if (error instanceof ExternalServiceError) return { state: "failed", category: "external" };
  if (error instanceof AppError) return { state: "completed", category: "rejected" };
  return { state: "failed", category: "internal" };
}

function finalize(store: UpdateClaimStore, log: Log, botId: number, updateId: number, outcome: UpdateClaimOutcome) {
  try {
    if (!store.finish(botId, updateId, outcome)) {
      log.warn({ updateId, category: "update-claim-not-finalized" }, "The update claim was not in the running state; left as it is");
    }
  } catch (error) {
    log.error({ updateId, category: "update-claim-finalize-failed", code: errorCode(error) }, "Could not record the end of the update; its claim stays and keeps suppressing it");
  }
}

function purgeOneBatch(store: UpdateClaimStore, log: Log) {
  try {
    store.purgeExpired(PURGE_BATCH);
  } catch (error) {
    log.warn({ category: "update-claim-purge-failed", code: errorCode(error) }, "Could not remove expired update claims");
  }
}

/** better-sqlite3 errors carry a stable code such as SQLITE_FULL; anything else is reported as unknown rather than described. */
function errorCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]{1,40}$/.test(code) ? code : "unknown";
}
