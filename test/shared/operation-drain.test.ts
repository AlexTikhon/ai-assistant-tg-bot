import { describe, expect, it, vi } from "vitest";
import { Operations, OperationCancelledError, onOperationDrained, operationStep } from "../../src/shared/operation.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("onOperationDrained", () => {
  it("is not available outside an operation", () => {
    const cleanup = vi.fn();

    expect(onOperationDrained(cleanup)).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["returns", async () => undefined],
    ["throws", async () => { throw new Error("handler failed"); }],
  ])("runs exactly once, after the handler %s", async (_label, task) => {
    const operations = new Operations();
    const cleanup = vi.fn();

    await Promise.resolve(operations.run(1000, async () => {
      expect(onOperationDrained(cleanup)).toBe(true);
      expect(cleanup).not.toHaveBeenCalled();
      await task();
    })).catch(() => undefined);
    await operations.shutdown();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("waits for a provider that ignores cancellation, although the caller already has its timeout", async () => {
    const operations = new Operations();
    const cleanup = vi.fn();
    const provider = deferred();

    await expect(operations.run(10, async () => {
      onOperationDrained(cleanup);
      await operationStep(() => provider.promise);
    })).rejects.toBeInstanceOf(OperationCancelledError);

    await tick();
    expect(cleanup).not.toHaveBeenCalled();
    expect(operations.activeCount).toBe(1);

    provider.resolve();
    await operations.shutdown();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(operations.activeCount).toBe(0);
  });

  it("waits for handler compensation that continues after the deadline", async () => {
    const operations = new Operations();
    const cleanup = vi.fn();
    const compensation = deferred();

    await expect(operations.run(10, async (signal) => {
      onOperationDrained(cleanup);
      try {
        await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      } finally {
        await compensation.promise;
      }
    })).rejects.toBeInstanceOf(OperationCancelledError);

    await tick();
    expect(cleanup).not.toHaveBeenCalled();

    compensation.resolve();
    await operations.shutdown();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("completes shutdown only after the cleanup has run", async () => {
    const operations = new Operations();
    const order: string[] = [];
    const provider = deferred();
    const running = operations.run(1000, async () => {
      onOperationDrained(() => void order.push("cleanup"));
      await operationStep(() => provider.promise);
    });

    const shutdown = operations.shutdown().then(() => void order.push("shutdown"));
    await expect(running).rejects.toBeInstanceOf(OperationCancelledError);
    provider.resolve();
    await shutdown;

    expect(order).toEqual(["cleanup", "shutdown"]);
  });

  it("runs every cleanup even when one throws, and never raises an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const operations = new Operations();
      const first = vi.fn(() => { throw new Error("cleanup failed"); });
      const second = vi.fn();

      await operations.run(1000, async () => {
        onOperationDrained(first);
        onOperationDrained(second);
      });
      await operations.shutdown();
      await tick();

      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
