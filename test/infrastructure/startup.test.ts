import { describe, expect, it, vi } from "vitest";
import type { Application } from "../../src/composition-root.js";
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
    readiness: { schemaVersion: 8, dataDir: "/data", version: "1.2.3", confidenceMode: "shadow" },
    startupCheck: vi.fn(async () => {
      events.push("startupCheck");
    }),
    close: vi.fn(() => void events.push("close")),
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
