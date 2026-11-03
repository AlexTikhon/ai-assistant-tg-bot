import { Telegraf } from "telegraf";
import { describe, expect, it, vi } from "vitest";
import type { Application } from "../../src/composition-root.js";
import { runApplication, startApplication } from "../../src/lifecycle.js";
import { OperationCancelledError } from "../../src/shared/operation.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Real Telegraf launch/poll/stop with a controlled transport, including cancellation-ignoring startup calls. */
function setup(blocked?: string) {
  const bot = new Telegraf("test-token");
  const reached = deferred();
  const release = deferred();
  const calls: string[] = [];
  const transport = vi.spyOn(bot.telegram, "callApi").mockImplementation((async (method, _payload, options) => {
    calls.push(method);
    if (method === blocked) { reached.resolve(); await release.promise; }
    if (method === "getMe") return { id: 123, is_bot: true, first_name: "Test", username: "test_bot" };
    if (method === "getUpdates") {
      reached.resolve();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("stopped"), { name: "AbortError" })), { once: true });
      });
    }
    return true;
  }) as typeof bot.telegram.callApi);
  const drain = vi.fn(async () => undefined);
  const close = vi.fn();
  const app = { bot, drain, close } as unknown as Application;
  return { app, bot, transport, reached, release, calls, close, drain };
}

describe("real Telegraf polling lifecycle", () => {
  it.each(["setMyCommands", "getMe", "deleteWebhook"])("shutdown during %s fences late startup and drains before close", async (stage) => {
    const { app, reached, release, calls, close, drain } = setup(stage);
    const controller = new AbortController();
    const starting = startApplication(app, controller.signal);
    const rejected = expect(starting).rejects.toBeInstanceOf(OperationCancelledError);
    await reached.promise;
    controller.abort();
    await tick();
    expect(drain).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    await rejected;
    expect(calls).toEqual(["setMyCommands", "getMe", "deleteWebhook"].slice(0, ["setMyCommands", "getMe", "deleteWebhook"].indexOf(stage) + 1));
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not report ready at onLaunch while deleteWebhook is pending", async () => {
    const { app, reached, release, calls, transport, close } = setup("deleteWebhook");
    let ready = false;
    const starting = startApplication(app).then((running) => { ready = true; return running; });
    await reached.promise;
    await tick();
    expect(ready).toBe(false);
    expect(calls).not.toContain("getUpdates");
    release.resolve();
    const running = await starting;
    expect(calls).toContain("getUpdates");
    await Promise.all([running.shutdown("test"), running.shutdown("again")]);
    expect(close).toHaveBeenCalledOnce();
    expect(app.bot.telegram.callApi).toBe(transport);
  });

  it("an already cancelled start calls no Telegram API and closes once", async () => {
    const { app, calls, close } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(startApplication(app, controller.signal)).rejects.toBeInstanceOf(OperationCancelledError);
    expect(calls).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("normalizes a transport abort during startup to a clean shutdown cancellation", async () => {
    const { app, transport, close } = setup();
    const reached = deferred();
    transport.mockImplementation(((_method, _payload, options) => {
      reached.resolve();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    }));
    const controller = new AbortController();
    const starting = startApplication(app, controller.signal);
    const rejected = expect(starting).rejects.toMatchObject({ kind: "shutdown" });
    await reached.promise;
    controller.abort();
    await rejected;
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["setMyCommands", "getMe", "deleteWebhook"])("a failed %s closes once and never starts polling", async (stage) => {
    const { app, calls, transport, close, drain } = setup();
    const original = transport.getMockImplementation()!;
    const failure = new Error("startup failed");
    transport.mockImplementation(((method, payload, options) => {
      if (method === stage) return Promise.reject(failure);
      return original(method, payload, options);
    }));
    await expect(startApplication(app)).rejects.toBe(failure);
    expect(calls).not.toContain("getUpdates");
    expect(drain).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("registers process signals before command sync and removes them after cancelled startup", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const { app, reached, release, close } = setup("setMyCommands");
    const starting = runApplication(app);
    const rejected = expect(starting).rejects.toBeInstanceOf(OperationCancelledError);
    await reached.promise;
    expect(process.listenerCount("SIGTERM")).toBe(before[1] + 1);
    process.emit("SIGTERM");
    release.resolve();
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });

  it("removes process listeners after normal shutdown and waits for application drainage", async () => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const { app, close } = setup();
    const drained = deferred();
    app.drain = () => drained.promise;
    const running = await runApplication(app);
    const stopping = running.shutdown("test");
    await tick();
    expect(close).not.toHaveBeenCalled();
    drained.resolve();
    await stopping;
    expect(close).toHaveBeenCalledOnce();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  });
});
