import { Context, Telegram } from "telegraf";
import { describe, expect, it, vi } from "vitest";
import { Operations } from "../../src/shared/operation.js";
import { createOperationMiddleware } from "../../src/telegram/operation.js";
import { errorBoundary } from "../../src/telegram/middleware.js";
import { replyLongText } from "../../src/telegram/reply.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
  const telegram = new Telegram("test");
  const calls: Array<{ method: string; payload: unknown }> = [];
  const transport = vi.spyOn(telegram, "callApi").mockImplementation((async (method, payload) => {
    calls.push({ method, payload });
    return true;
  }));
  const ctx = new Context<Context["update"]>({ update_id: 1, message: {
    message_id: 1, date: 1, chat: { id: 1, type: "private", first_name: "Test" }, text: "question",
    from: { id: 1, is_bot: false, first_name: "Test" },
  } }, telegram, { id: 2, is_bot: true, first_name: "Bot", username: "test_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false });
  const operations = new Operations();
  const run = (handler: () => Promise<void>, timeout = 20) => errorBoundary(ctx, async () => {
    await createOperationMiddleware(operations, timeout)(ctx, handler);
  });
  return { ctx, calls, transport, operations, run };
}

describe("Telegram delivery cancellation and ambiguous outcomes", () => {
  it.each([false, true])("a send in flight gets cancellation, no timeout/follow-up, and stays tracked (ignores cancellation: %s)", async (ignoreCancellation) => {
    const { ctx, transport, operations, run } = setup();
    const entered = deferred();
    const release = deferred();
    let signal: { aborted: boolean } | undefined;
    let sends = 0;
    transport.mockImplementation((async (_method, _payload, options) => {
      sends += 1;
      signal = options?.signal;
      entered.resolve();
      if (ignoreCancellation) await release.promise;
      else await new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
      });
      return true;
    }));
    const handling = run(() => replyLongText(ctx, "x".repeat(9000)), 50);
    await entered.promise;
    await handling;
    expect(signal?.aborted).toBe(true);
    expect(sends).toBe(1);
    if (ignoreCancellation) {
      expect(operations.activeCount).toBe(1);
      const drained = vi.fn();
      const shutdown = operations.shutdown().then(drained);
      await tick();
      expect(drained).not.toHaveBeenCalled();
      release.resolve();
      await shutdown;
    } else await operations.shutdown();
    expect(operations.activeCount).toBe(0);
    expect(sends).toBe(1);
  });

  it("stops between multipart sends without adding a conflicting timeout after the first part", async () => {
    const { ctx, calls, operations, run } = setup();
    const firstSent = deferred();
    const release = deferred();
    const handling = run(async () => {
      await ctx.reply("first part");
      firstSent.resolve();
      await release.promise;
      await ctx.reply("late second part");
    }, 50);
    await firstSent.promise;
    await handling;
    expect(calls).toHaveLength(1);
    release.resolve();
    await operations.shutdown();
    expect(calls).toHaveLength(1);
  });

  it("does not retry a delivery failure or send a generic error after an ambiguous send", async () => {
    const { ctx, transport, run } = setup();
    transport.mockRejectedValue(new Error("connection reset after sending"));
    await run(async () => { await ctx.reply("answer"); });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("still sends exactly one safe timeout when no answer delivery was attempted", async () => {
    const { calls, run, operations } = setup();
    const release = deferred();
    await run(() => release.promise);
    expect(calls).toEqual([{ method: "sendMessage", payload: { chat_id: 1, text: expect.stringContaining("cancelled") } }]);
    release.resolve();
    await operations.shutdown();
  });
});
