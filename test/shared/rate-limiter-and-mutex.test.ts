import { describe, expect, it } from "vitest";
import { RateLimitError } from "../../src/shared/errors.js";
import { KeyedMutex } from "../../src/shared/keyed-mutex.js";
import { RateLimiter } from "../../src/shared/rate-limiter.js";

function createClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("RateLimiter", () => {
  it("allows up to `limit` operations per window and then reports when to retry", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, now: clock.now });

    expect(limiter.check("u1")).toEqual({ allowed: true });
    clock.advance(10_000);
    expect(limiter.check("u1")).toEqual({ allowed: true });
    expect(limiter.check("u1")).toEqual({ allowed: true });

    // The oldest hit (t=0) leaves the window at t=60s; we are at t=10s.
    expect(limiter.check("u1")).toEqual({ allowed: false, retryAfterMs: 50_000 });
  });

  it("slides: capacity returns as old hits expire", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ limit: 2, windowMs: 1_000, now: clock.now });

    limiter.check("u1");
    clock.advance(600);
    limiter.check("u1");
    expect(limiter.check("u1").allowed).toBe(false);

    clock.advance(500); // first hit is now 1100ms old
    expect(limiter.check("u1").allowed).toBe(true);
    expect(limiter.check("u1").allowed).toBe(false);
  });

  it("does not count rejected attempts against the user", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, now: clock.now });

    limiter.check("u1");
    for (let i = 0; i < 50; i += 1) limiter.check("u1");
    clock.advance(1_000);

    expect(limiter.check("u1").allowed).toBe(true);
  });

  it("tracks users independently", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, now: createClock().now });

    expect(limiter.check("u1").allowed).toBe(true);
    expect(limiter.check("u2").allowed).toBe(true);
    expect(limiter.check("u1").allowed).toBe(false);
  });

  it("forgets idle users so memory does not grow forever", () => {
    const clock = createClock();
    const limiter = new RateLimiter({ limit: 5, windowMs: 1_000, now: clock.now });

    for (let user = 0; user < 100; user += 1) limiter.check(`user-${user}`);
    expect(limiter.trackedKeys).toBe(100);

    clock.advance(5_000);
    limiter.check("someone-new");

    expect(limiter.trackedKeys).toBe(1);
  });

  it("assertAllowed throws a friendly RateLimitError with the wait time", () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: createClock().now });
    limiter.assertAllowed("u1");

    expect(() => limiter.assertAllowed("u1")).toThrow(RateLimitError);
    expect(() => limiter.assertAllowed("u1")).toThrow(/60 seconds/);
  });

  it("rejects nonsensical configuration", () => {
    expect(() => new RateLimiter({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
  });
});

describe("KeyedMutex", () => {
  it("runs tasks with the same key one after another, in order", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    const task = (name: string, delayTicks: number) => async () => {
      events.push(`start ${name}`);
      for (let i = 0; i < delayTicks; i += 1) await Promise.resolve();
      events.push(`end ${name}`);
      return name;
    };

    const results = await Promise.all([mutex.run("k", task("a", 5)), mutex.run("k", task("b", 1))]);

    expect(results).toEqual(["a", "b"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("does not serialize different keys", async () => {
    const mutex = new KeyedMutex();
    const events: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));

    const first = mutex.run("a", async () => {
      events.push("a started");
      await blocked;
      events.push("a finished");
    });
    await mutex.run("b", async () => void events.push("b ran"));
    release();
    await first;

    expect(events).toEqual(["a started", "b ran", "a finished"]);
  });

  it("keeps working after a task fails and propagates the error to its caller only", async () => {
    const mutex = new KeyedMutex();

    const failing = mutex.run("k", async () => {
      throw new Error("boom");
    });
    const following = mutex.run("k", async () => "still runs");

    await expect(failing).rejects.toThrow("boom");
    await expect(following).resolves.toBe("still runs");
  });

  it("does not retain finished keys", async () => {
    const mutex = new KeyedMutex();

    await Promise.all([mutex.run("a", async () => 1), mutex.run("b", async () => 2), mutex.run("a", async () => 3)]);

    expect(mutex.activeKeys).toBe(0);
  });
});
