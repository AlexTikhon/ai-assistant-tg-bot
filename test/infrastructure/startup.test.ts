import { TelegramError } from "telegraf";
import { describe, expect, it, vi } from "vitest";
import type { Application } from "../../src/composition-root.js";
import { loadConfig } from "../../src/config/config.js";
import { createLogger } from "../../src/shared/logger.js";
import { startApplication } from "../../src/lifecycle.js";
import type { RunningApplication } from "../../src/lifecycle.js";
import { StartupError } from "../../src/shared/errors.js";
import { startBot } from "../../src/startup.js";

type Entry = { level: string; fields: Record<string, unknown>; message: string };

function setup(overrides: { readConfig?: () => unknown; createApplication?: () => Application; runApplication?: (app: Application) => Promise<RunningApplication> } = {}) {
  const entries: Entry[] = [];
  const logAt = (level: string) => (fields: Record<string, unknown>, message: string) => void entries.push({ level, fields, message });
  const log = { info: logAt("info"), warn: logAt("warn"), fatal: logAt("fatal") };

  const events: string[] = [];
  let stopPolling: () => void = () => undefined;
  const bot = {
    telegram: { setMyCommands: vi.fn(async () => true) },
    // Like Telegraf: the polling promise settles when the bot is stopped.
    launch: vi.fn((onLaunch: () => void) => {
      onLaunch();
      return new Promise<void>((resolve) => (stopPolling = resolve));
    }),
    stop: vi.fn(() => {
      events.push("bot.stop");
      stopPolling();
    }),
  };
  const app = {
    bot,
    readiness: { schemaVersion: 8, dataDir: "/data", version: "1.2.3", confidenceMode: "shadow", logQuestions: false },
    startupCheck: vi.fn(async () => {
      events.push("startupCheck");
    }),
    close: vi.fn(() => void events.push("close")),
    drain: async () => undefined,
  } as unknown as Application;

  const deps = {
    readConfig: overrides.readConfig ?? (() => ({ nodeEnv: "test" })),
    createApplication: overrides.createApplication ?? (() => app),
    runApplication: overrides.runApplication ?? ((application: Application) => startApplication(application)),
    log,
  };

  return { deps, app, bot, entries, events, stages: () => entries.map((entry) => entry.fields.stage).filter(Boolean) };
}

describe("startBot: readiness stages", () => {
  it("logs configuration, database, storage and the Telegram connection as separate stages, in order, and starts polling last", async () => {
    const { deps, entries, events } = setup();

    const result = await startBot(deps);

    expect(result.exitCode).toBe(0); // (the startup check logs its own summary line)
    expect(entries.filter((entry) => entry.fields.stage).map((entry) => entry.fields.stage)).toEqual(["config", "database", "storage", "retrieval", "telegram", "ready"]);
    expect(entries.find((entry) => entry.fields.stage === "database")?.fields).toMatchObject({ schemaVersion: 8, version: "1.2.3" });
    expect(events).toEqual(["startupCheck"]);
  });

  it("warns at startup when LOG_QUESTIONS writes question text to the log, and only then", async () => {
    const off = setup();
    await startBot(off.deps);
    expect(off.entries.filter((entry) => entry.level === "warn")).toEqual([]);

    const on = setup();
    on.app.readiness.logQuestions = true;
    await startBot(on.deps);
    expect(on.entries.filter((entry) => entry.level === "warn")).toEqual([
      expect.objectContaining({ fields: { stage: "logging" }, message: expect.stringContaining("LOG_QUESTIONS is on") }),
    ]);
  });

  it("never logs secrets: the configuration object itself is not logged", async () => {
    const { deps, entries } = setup({ readConfig: () => ({ telegram: { botToken: "123456:SECRET" }, openai: { apiKey: "sk-secret" } }) });

    await startBot(deps);

    expect(JSON.stringify(entries)).not.toMatch(/SECRET|sk-secret/);
  });
});

describe("startBot: failures stop the start and leave nothing running", () => {
  it("invalid configuration: fatal, non-zero, nothing is created", async () => {
    const createApplication = vi.fn();
    const { deps, entries } = setup({
      readConfig: () => {
        throw new Error("Invalid configuration:\n- TELEGRAM_BOT_TOKEN: Required");
      },
      createApplication,
    });

    const result = await startBot(deps);

    expect(result.exitCode).toBe(1);
    expect(createApplication).not.toHaveBeenCalled();
    expect(entries.at(-1)).toMatchObject({ level: "fatal", fields: { stage: "config" } });
  });

  it("a failing database migration: fatal at the database stage, polling is never attempted", async () => {
    const runApplication = vi.fn();
    const { deps, entries } = setup({
      createApplication: () => {
        throw new StartupError("database", new Error("migration 8 failed"));
      },
      runApplication,
    });

    const result = await startBot(deps);

    expect(result.exitCode).toBe(1);
    expect(runApplication).not.toHaveBeenCalled();
    expect(entries.at(-1)).toMatchObject({ level: "fatal", fields: { stage: "database" } });
  });

  it("a storage directory that cannot be used: fatal at the storage stage", async () => {
    const { deps, entries } = setup({
      createApplication: () => {
        throw new StartupError("storage", new Error("EACCES"));
      },
    });

    expect((await startBot(deps)).exitCode).toBe(1);
    expect(entries.at(-1)).toMatchObject({ level: "fatal", fields: { stage: "storage" } });
  });

  it("a Telegram connection failure: closes the database exactly once, logs the stage, exits non-zero", async () => {
    const { deps, app, bot, entries } = setup();
    bot.telegram.setMyCommands.mockRejectedValue(new Error("401 Unauthorized"));

    const result = await startBot(deps);

    expect(result.exitCode).toBe(1);
    expect(app.close).toHaveBeenCalledOnce();
    expect(bot.launch).not.toHaveBeenCalled();
    expect(entries.at(-1)).toMatchObject({ level: "fatal", fields: { stage: "telegram" } });
  });

  it("a polling start that fails after connecting also closes the database", async () => {
    const { deps, app, bot } = setup();
    bot.launch.mockImplementation(() => Promise.reject(new Error("409 Conflict")));

    expect((await startBot(deps)).exitCode).toBe(1);
    expect(app.close).toHaveBeenCalledOnce();
  });

  it("a failing startup check does not stop the start: it is a diagnostic", async () => {
    const { deps, app, entries } = setup();
    (app.startupCheck as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));

    expect((await startBot(deps)).exitCode).toBe(0);
    expect(entries.some((entry) => entry.level === "warn" && entry.fields.stage === "startup-check")).toBe(true);
  });
});

describe("startBot: failures stay actionable in a content-free log", () => {
  const SENTINEL = "SYNTHETIC_PRIVATE_VALUE_DO_NOT_LOG";

  function realLog() {
    const lines: Array<Record<string, any>> = [];
    const logger = createLogger({ write: (line: string) => void lines.push(JSON.parse(line)) }, "info");
    return { lines, log: { info: logger.info.bind(logger), warn: logger.warn.bind(logger), fatal: logger.fatal.bind(logger) }, text: () => JSON.stringify(lines) };
  }

  it("invalid configuration names every missing or invalid variable - and none of their values", async () => {
    const { deps } = setup({ readConfig: () => loadConfig({ CHUNK_SIZE: SENTINEL, RETRIEVAL_CONFIDENCE_MODE: SENTINEL, RAG_DEBUG: SENTINEL }) });
    const { lines, log, text } = realLog();

    const result = await startBot({ ...deps, log });

    expect(result.exitCode).toBe(1);
    const fatal = lines.at(-1)!;
    expect(fatal).toMatchObject({ level: 60, stage: "config", err: { category: "startup", type: "ConfigError", stage: "config" } });
    expect(fatal.invalidVariables).toEqual(expect.arrayContaining(["TELEGRAM_BOT_TOKEN", "OPENAI_API_KEY", "CHUNK_SIZE", "RETRIEVAL_CONFIDENCE_MODE", "RAG_DEBUG"]));
    expect(text()).not.toContain(SENTINEL);
    expect(text()).not.toContain("Invalid configuration:");
  });

  it("a configuration error that is not one of ours is logged by kind only", async () => {
    const { deps } = setup({ readConfig: () => { throw new Error(`TELEGRAM_BOT_TOKEN=${SENTINEL}`); } });
    const { lines, log, text } = realLog();

    expect((await startBot({ ...deps, log })).exitCode).toBe(1);

    expect(lines.at(-1)).toMatchObject({ stage: "config", err: { category: "unknown", type: "Error" } });
    expect(lines.at(-1)).not.toHaveProperty("invalidVariables");
    expect(text()).not.toContain(SENTINEL);
  });

  it("a database failure keeps its stage, the operator's advice and the safe category and code of its cause - not the cause's text", async () => {
    const sqlite = Object.assign(new Error(`file is not a database: /home/${SENTINEL}/app.db`), { name: "SqliteError", code: "SQLITE_NOTADB" });
    const { deps, app } = setup({ createApplication: () => { throw new StartupError("database", sqlite, "The database file is corrupt. Restore a verified backup (npm run restore)."); } });
    const { lines, log, text } = realLog();

    const result = await startBot({ ...deps, log });

    expect(result.exitCode).toBe(1);
    expect(lines.at(-1)).toMatchObject({
      level: 60,
      stage: "database",
      advice: "The database file is corrupt. Restore a verified backup (npm run restore).",
      err: { category: "startup", type: "StartupError", stage: "database", cause: { category: "storage", type: "SqliteError", code: "SQLITE_NOTADB" } },
    });
    expect(text()).not.toContain(SENTINEL);
    expect(app.close).not.toHaveBeenCalled(); // nothing was opened
  });

  it("a Telegram connection failure still closes the database once, logs the stage and keeps the safe facts", async () => {
    const { deps, app, bot } = setup();
    const { lines, log, text } = realLog();
    bot.telegram.setMyCommands.mockRejectedValue(new TelegramError({ error_code: 401, description: `Unauthorized ${SENTINEL}` }, { method: "setMyCommands", payload: { commands: SENTINEL } }));

    const result = await startBot({ ...deps, log });

    expect(result.exitCode).toBe(1);
    expect(app.close).toHaveBeenCalledOnce();
    expect(lines.at(-1)).toMatchObject({ stage: "telegram", err: { category: "external", service: "telegram", method: "setMyCommands", status: 401 } });
    expect(text()).not.toContain(SENTINEL);
  });
});

describe("startBot: graceful shutdown still works", () => {
  it("stops the bot, waits for polling to end and then closes the database", async () => {
    const { deps, app, bot, events } = setup();

    const { exitCode, running } = await startBot(deps);
    await running!.shutdown("SIGTERM");

    expect(exitCode).toBe(0);
    expect(bot.stop).toHaveBeenCalledOnce();
    expect(app.close).toHaveBeenCalledOnce();
    expect(events).toEqual(["startupCheck", "bot.stop", "close"]);
  });
});
