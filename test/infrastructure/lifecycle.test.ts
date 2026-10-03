import { describe, expect, it, vi } from "vitest";
import type { Application } from "../../src/composition-root.js";
import { startApplication } from "../../src/lifecycle.js";

/** A Telegraf stand-in whose polling promise settles only when stop() has been called and `finish()` runs. */
function createFakeApplication() {
  let finishPolling!: () => void;
  const events: string[] = [];

  const bot = {
    telegram: { setMyCommands: vi.fn(async () => true) },
    launch: vi.fn((onLaunch: () => void) => {
      onLaunch();
      return new Promise<void>((resolve) => {
        finishPolling = () => {
          events.push("polling finished");
          resolve();
        };
      });
    }),
    stop: vi.fn(() => void events.push("bot.stop")),
  };
  const close = vi.fn(() => void events.push("close"));

  return { app: { bot, close } as unknown as Application, bot, close, events, finish: () => finishPolling() };
}

describe("application lifecycle", () => {
  it("syncs commands and reports ready without waiting for polling to end", async () => {
    const { app, bot } = createFakeApplication();

    await startApplication(app);

    expect(bot.telegram.setMyCommands).toHaveBeenCalledOnce();
    expect(bot.launch).toHaveBeenCalledOnce();
  });

  it("stops the bot, waits for in-flight work, and only then closes resources", async () => {
    const { app, close, events, finish } = createFakeApplication();
    const running = await startApplication(app);

    const shutdown = running.shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["bot.stop"]);
    expect(close).not.toHaveBeenCalled(); // an update is still being handled

    finish();
    await shutdown;

    expect(events).toEqual(["bot.stop", "polling finished", "close"]);
  });

  it("is idempotent: a second signal does not stop or close twice", async () => {
    const { app, bot, close, finish } = createFakeApplication();
    const running = await startApplication(app);

    const first = running.shutdown("SIGINT");
    const second = running.shutdown("SIGTERM");
    finish();
    await Promise.all([first, second]);

    expect(bot.stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("still closes resources when stopping the bot throws", async () => {
    const { app, bot, close } = createFakeApplication();
    bot.stop.mockImplementation(() => {
      throw new Error("Bot is not running!");
    });
    const running = await startApplication(app);

    await running.shutdown("SIGINT");

    expect(close).toHaveBeenCalledOnce();
  });
});
