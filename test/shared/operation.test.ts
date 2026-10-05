import { describe, expect, it, vi } from "vitest";
import { KeyedMutex } from "../../src/shared/keyed-mutex.js";
import { Operations, OperationCancelledError, operationSignal, operationStep } from "../../src/shared/operation.js";

describe("operation deadlines and shutdown", () => {
  it("cancels an ignored provider promise and stops the next application step", async () => {
    const operations = new Operations();
    const next = vi.fn();
    let finish!: () => void;
    const provider = new Promise<void>((resolve) => { finish = resolve; });
    await expect(operations.run(10, async (signal) => {
      expect(operationSignal()).toBe(signal);
      await operationStep(() => provider);
      next();
    })).rejects.toBeInstanceOf(OperationCancelledError);
    let drained = false;
    const shutdown = operations.shutdown().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await shutdown;
    expect(next).not.toHaveBeenCalled();
    expect(operations.activeCount).toBe(0);
  });

  it("tracks timed-out middleware until it actually settles, independently of the race result", async () => {
    const operations = new Operations();
    let finish!: () => void;
    const work = new Promise<void>((resolve) => { finish = resolve; });
    await expect(operations.run(10, () => work)).rejects.toBeInstanceOf(OperationCancelledError);
    expect(operations.activeCount).toBe(1);
    let drained = false;
    const shutdown = operations.shutdown().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish(); await shutdown;
    expect(operations.activeCount).toBe(0);
    await expect(operations.run(100, async () => undefined)).rejects.toBeInstanceOf(OperationCancelledError);
  });

  it("never starts paid work that timed out while waiting for a user mutex", async () => {
    const mutex = new KeyedMutex(); const operations = new Operations();
    let release!: () => void;
    const first = mutex.run("u", () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const paidWork = vi.fn(async () => undefined);
    await expect(operations.run(10, () => mutex.run("u", paidWork))).rejects.toBeInstanceOf(OperationCancelledError);
    release(); await first;
    await operations.shutdown();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(paidWork).not.toHaveBeenCalled();
    expect(mutex.activeKeys).toBe(0);
  });
});
