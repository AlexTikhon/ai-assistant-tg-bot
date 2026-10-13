import type { Context } from "telegraf";
import { describe, expect, it, vi } from "vitest";
import { OverloadedError, ValidationError } from "../../src/shared/errors.js";
import { OperationCancelledError, Operations, operationStep } from "../../src/shared/operation.js";
import { WorkloadLimiter } from "../../src/shared/workload-limiter.js";
import { createWorkloadAdmissionMiddleware } from "../../src/telegram/workload-admission.js";

const ctx = (userId: number | undefined, text?: string) =>
  ({ from: userId === undefined ? undefined : { id: userId }, message: text === undefined ? {} : { text } }) as unknown as Context;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

type Log = NonNullable<Parameters<typeof createWorkloadAdmissionMiddleware>[1]>["log"];
type Entry = { fields: Record<string, unknown>; message: string };

function setup(limits = { maxActive: 2, maxPerUser: 1 }, options: { skipCommands?: boolean } = {}) {
  const limiter = new WorkloadLimiter(limits);
  const warnings: Entry[] = [];
  const log = { warn: (fields: Record<string, unknown>, message: string) => void warnings.push({ fields, message }) } as unknown as Log;
  const middleware = createWorkloadAdmissionMiddleware(limiter, { ...options, log });
  const operations = new Operations();
  /** One update: the middleware inside an operation scope, as the Telegram chain runs it. */
  const handle = (context: Context, next: () => Promise<unknown>, timeoutMs = 1000) =>
    operations.run(timeoutMs, async () => { await middleware(context, next as () => Promise<void>); });
  return { limiter, middleware, handle, operations, warnings };
}

describe("workload admission middleware", () => {
  it("holds one lease for the whole handler and frees it when the operation has drained", async () => {
    const { limiter, handle, operations } = setup();
    const seen: number[] = [];

    await handle(ctx(1), async () => void seen.push(limiter.activeCount));
    await operations.shutdown();

    expect(seen).toEqual([1]);
    expect(limiter.activeCount).toBe(0);
    expect(limiter.trackedUsers).toBe(0);
  });

  it("keeps the slot after the deadline while a provider that ignores cancellation is still running", async () => {
    const { limiter, handle, operations } = setup({ maxActive: 1, maxPerUser: 1 });
    const provider = deferred();

    await expect(handle(ctx(1), async () => { await operationStep(() => provider.promise); }, 10)).rejects.toBeInstanceOf(OperationCancelledError);
    await tick();

    expect(limiter.activeCount).toBe(1);
    const other = vi.fn();
    await expect(handle(ctx(2), other)).rejects.toBeInstanceOf(OverloadedError);
    expect(other).not.toHaveBeenCalled();

    provider.resolve();
    await tick();

    expect(limiter.activeCount).toBe(0);
    await handle(ctx(2), async () => undefined);
    await operations.shutdown();
  });

  it("refuses with the overload error when the global bound is reached, and starts nothing", async () => {
    const { limiter, handle, operations } = setup({ maxActive: 2, maxPerUser: 1 });
    const gate = deferred();
    const running = [1, 2].map((user) => handle(ctx(user), () => gate.promise));
    await tick();
    const next = vi.fn();

    await expect(handle(ctx(3), next)).rejects.toBeInstanceOf(OverloadedError);

    expect(next).not.toHaveBeenCalled();
    expect(limiter.activeCount).toBe(2);
    gate.resolve();
    await Promise.all(running);
    await operations.shutdown();
    expect(limiter.activeCount).toBe(0);
  });

  it("refuses one user's excess but admits another user", async () => {
    const { limiter, handle, operations } = setup({ maxActive: 3, maxPerUser: 1 });
    const gate = deferred();
    const first = handle(ctx(1), () => gate.promise);
    await tick();

    await expect(handle(ctx(1), vi.fn())).rejects.toBeInstanceOf(OverloadedError);
    const second = handle(ctx(2), () => gate.promise);
    await tick();

    expect(limiter.activeCount).toBe(2);
    gate.resolve();
    await Promise.all([first, second]);
    await operations.shutdown();
    expect(limiter.trackedUsers).toBe(0);
  });

  it("logs only the refusing bound and a count", async () => {
    const { handle, operations, warnings } = setup({ maxActive: 2, maxPerUser: 1 });
    const gate = deferred();
    const first = handle(ctx(777_000_111, "private question text"), () => gate.promise);
    await tick();

    await handle(ctx(777_000_111, "private question text"), vi.fn()).catch(() => undefined);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].fields).toEqual({ category: "workload-rejected", scope: "user", active: 1 });
    expect(JSON.stringify(warnings)).not.toMatch(/777000111|private question/);
    gate.resolve();
    await first;
    await operations.shutdown();
  });

  it("does not charge slash commands when skipCommands is on, even at capacity", async () => {
    const { limiter, handle, operations } = setup({ maxActive: 1, maxPerUser: 1 }, { skipCommands: true });
    const gate = deferred();
    const first = handle(ctx(1, "a question"), () => gate.promise);
    await tick();
    const next = vi.fn(async () => undefined);

    await handle(ctx(2, "/unknown"), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(limiter.activeCount).toBe(1);
    await expect(handle(ctx(2, "another question"), vi.fn())).rejects.toBeInstanceOf(OverloadedError);
    gate.resolve();
    await first;
    await operations.shutdown();
  });

  it("refuses an update without a user and takes no capacity", async () => {
    const { limiter, handle, operations } = setup();
    const next = vi.fn();

    await expect(handle(ctx(undefined), next)).rejects.toBeInstanceOf(ValidationError);

    expect(next).not.toHaveBeenCalled();
    expect(limiter.activeCount).toBe(0);
    await operations.shutdown();
  });

  it("takes no capacity once the operation is cancelled by shutdown", async () => {
    const { limiter, middleware, operations } = setup();
    const gate = deferred();
    const next = vi.fn();
    const running = operations.run(1000, async () => {
      await gate.promise;
      await middleware(ctx(1), next);
    });

    const shutdown = operations.shutdown();
    gate.resolve();

    await expect(running).rejects.toBeInstanceOf(OperationCancelledError);
    await shutdown;
    expect(next).not.toHaveBeenCalled();
    expect(limiter.activeCount).toBe(0);
  });

  it("outside an operation scope the lease is released as soon as the handler settles", async () => {
    const { limiter, middleware } = setup();

    await middleware(ctx(1), async () => undefined);
    expect(limiter.activeCount).toBe(0);

    await expect(Promise.resolve(middleware(ctx(1), async () => { throw new Error("boom"); }))).rejects.toThrow("boom");
    expect(limiter.activeCount).toBe(0);
    expect(limiter.trackedUsers).toBe(0);
  });
});
