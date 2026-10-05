import type { Application } from "./composition-root.js";
import type { RunningApplication } from "./lifecycle.js";
import { StartupError } from "./shared/errors.js";

type Log = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  fatal(fields: Record<string, unknown>, message: string): void;
};

type Dependencies<Config> = {
  /** Reads and validates the environment; throws with every problem listed. */
  readConfig(): Config;
  /** Opens and migrates the database, checks the data directory and wires everything. Throws a StartupError. */
  createApplication(config: Config): Application;
  /** Connects to Telegram and starts polling. */
  runApplication(app: Application): Promise<RunningApplication>;
  log: Log;
};

export type StartResult = { exitCode: number; running?: RunningApplication };

/**
 * Starts the bot in clearly separated, logged stages - configuration valid, database ready, storage ready,
 * Telegram connected - and stops at the first one that fails: nothing later is attempted, everything already
 * opened is closed, and the exit code is non-zero. In particular a failed migration never reaches polling.
 * No stage logs the configuration (it holds the bot token and the API key).
 */
export async function startBot<Config>(deps: Dependencies<Config>): Promise<StartResult> {
  const { log } = deps;

  let config: Config;
  try {
    config = deps.readConfig();
    log.info({ stage: "config" }, "Configuration valid");
  } catch (err) {
    log.fatal({ stage: "config", err }, "Invalid configuration; the bot was not started");
    return { exitCode: 1 };
  }

  let app: Application;
  try {
    app = deps.createApplication(config);
  } catch (err) {
    const stage = err instanceof StartupError ? err.stage : "database";
    log.fatal({ stage, err, ...(err instanceof StartupError && err.advice ? { advice: err.advice } : {}) }, `Startup failed at the ${stage} stage; the bot was not started`);
    return { exitCode: 1 };
  }
  log.info({ stage: "database", schemaVersion: app.readiness.schemaVersion, version: app.readiness.version }, "Database ready");
  log.info({ stage: "storage", dataDir: app.readiness.dataDir }, "Storage ready");
  // Shadow computes the answerability decision and logs it, but never changes a reply; enforce is an explicit operator decision.
  log.info({ stage: "retrieval", confidenceMode: app.readiness.confidenceMode }, `Retrieval confidence gate: ${app.readiness.confidenceMode}`);

  try {
    // A diagnostic: it must never be the reason the bot does not start.
    await app.startupCheck().catch((err) => log.warn({ stage: "startup-check", err }, "The startup check failed; continuing"));

    const running = await deps.runApplication(app);
    log.info({ stage: "telegram" }, "Connected to Telegram; polling");
    log.info({ stage: "ready" }, "Application started");
    return { exitCode: 0, running };
  } catch (err) {
    log.fatal({ stage: "telegram", err }, "Could not connect to Telegram; the bot was not started");
    await app.drain();
    app.close();
    return { exitCode: 1 };
  }
}
