import type { Application } from "./composition-root.js";
import { logger } from "./shared/logger.js";
import { OperationCancelledError } from "./shared/operation.js";
import { launchPolling } from "./telegram/polling.js";

/** After this long a stuck shutdown (e.g. a hanging provider call) is abandoned. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

export type RunningApplication = {
  /** Idempotent. Stops polling, waits for updates in flight, then releases resources. */
  shutdown(reason: string, exitCode?: number): Promise<void>;
};

/** Owns cleanup from the first startup await through polling termination, including startup failure. */
export async function startApplication(app: Application, signal?: AbortSignal, onStopped: () => void = () => undefined): Promise<RunningApplication> {
  const controller = new AbortController();
  if (signal?.aborted) controller.abort(new OperationCancelledError(undefined, "shutdown"));
  let state: "starting" | "running" | "stopping" | "stopped" = "starting";
  let shutdownPromise: Promise<void> | undefined;
  let pollingStarted = false;
  let ready!: () => void;
  let notReady!: (error: unknown) => void;
  const readiness = new Promise<void>((resolve, reject) => { ready = resolve; notReady = reject; });
  const polling = launchPolling(app.bot, controller.signal, () => {
    pollingStarted = true;
    if (state === "starting") { state = "running"; ready(); }
  });

  const shutdown = (reason: string, exitCode = 0): Promise<void> => {
    shutdownPromise ??= Promise.resolve().then(async () => {
      state = "stopping";
      controller.abort(new OperationCancelledError(undefined, "shutdown"));
      notReady(controller.signal.reason);
      logger.info({ reason }, "Shutting down");
      const forceExit = setTimeout(() => {
        logger.error("Graceful shutdown timed out, forcing exit");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExit.unref();
      try {
        if (pollingStarted) {
          try { app.bot.stop(reason); }
          catch (err) { logger.error({ err }, "Error while stopping the bot"); }
        }
        // Even if stop() throws, never close storage while launch/polling can still use it.
        const settled = await Promise.allSettled([polling, app.drain()]);
        for (const result of settled) {
          if (result.status === "rejected" && result.reason !== controller.signal.reason) {
            logger.error({ err: result.reason }, "Error draining in-flight work");
          }
        }
        try { app.close(); }
        catch (err) { logger.error({ err }, "Error while closing resources"); }
      } finally {
        state = "stopped";
        clearTimeout(forceExit);
        signal?.removeEventListener("abort", abort);
        onStopped();
        if (exitCode !== 0) process.exitCode = exitCode;
        logger.info("Shutdown complete");
      }
    });
    return shutdownPromise;
  };
  const abort = () => { void shutdown("startup-or-runtime-signal"); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  void polling.then(() => {
    if (state === "starting") notReady(new Error("Polling ended before it started"));
    else if (state === "running") void shutdown("polling-ended", 1);
  }, (err) => {
    if (state === "starting") notReady(err);
    else if (state === "running") {
      logger.fatal({ err }, "Bot polling crashed");
      void shutdown("polling-crash", 1);
    }
  });

  try {
    await readiness;
    controller.signal.throwIfAborted();
    logger.info("Bot is running");
    return { shutdown };
  } catch (error) {
    await shutdown("startup-stopped");
    throw error;
  }
}

/** Signals are owned before startup begins and removed after failure or shutdown. */
export async function runApplication(app: Application, signal?: AbortSignal): Promise<RunningApplication> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  const onTerminate = () => controller.abort();
  const remove = () => {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  };
  if (!signal) {
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
  }
  try {
    return await startApplication(app, signal ?? controller.signal, remove);
  } catch (error) {
    remove();
    throw error;
  }
}
