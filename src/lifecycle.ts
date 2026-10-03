import type { Application } from "./composition-root.js";
import { logger } from "./shared/logger.js";
import { botCommands } from "./telegram/ui/commands.js";

/** After this long a stuck shutdown (e.g. a hanging provider call) is abandoned. */
const SHUTDOWN_TIMEOUT_MS = 15_000;

export type RunningApplication = {
  /** Idempotent. Stops polling, waits for updates in flight, then releases resources. */
  shutdown(reason: string, exitCode?: number): Promise<void>;
};

/**
 * Syncs the command menu and starts long polling.
 *
 * In long-polling mode `bot.launch()` only settles once polling has *stopped*, so readiness is
 * signalled through its `onLaunch` callback instead of awaiting the returned promise.
 */
export async function startApplication(app: Application): Promise<RunningApplication> {
  await app.bot.telegram.setMyCommands(botCommands);

  let polling: Promise<void> = Promise.resolve();
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (reason: string, exitCode = 0) => {
    shutdownPromise ??= (async () => {
      logger.info({ reason }, "Shutting down");

      const forceExit = setTimeout(() => {
        logger.error("Graceful shutdown timed out, forcing exit");
        process.exit(1);
      }, SHUTDOWN_TIMEOUT_MS);
      forceExit.unref();

      try {
        // Stops fetching new updates; the polling promise settles after updates in flight are done.
        app.bot.stop(reason);
        await polling;
      } catch (err) {
        logger.error({ err }, "Error while stopping the bot");
      } finally {
        clearTimeout(forceExit);
        try {
          app.close();
        } catch (err) {
          logger.error({ err }, "Error while closing resources");
        }
        if (exitCode !== 0) {
          process.exitCode = exitCode;
        }
        logger.info("Shutdown complete");
      }
    })();

    return shutdownPromise;
  };

  await new Promise<void>((resolve, reject) => {
    polling = app.bot.launch(() => resolve());
    polling.then(resolve, reject);
  });

  logger.info("Bot is running");

  // Settles when polling stops: normally because of shutdown(), otherwise it crashed (e.g. 409 conflict).
  polling.catch((err) => {
    logger.fatal({ err }, "Bot polling crashed");
    void shutdown("polling-crash", 1);
  });

  return { shutdown };
}

/** Starts the application and shuts it down gracefully on SIGINT/SIGTERM. */
export async function runApplication(app: Application) {
  const running = await startApplication(app);

  process.once("SIGINT", () => void running.shutdown("SIGINT"));
  process.once("SIGTERM", () => void running.shutdown("SIGTERM"));
}
