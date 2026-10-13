import { describe, expect, it } from "vitest";
import { OverloadedError } from "../../src/shared/errors.js";
import { WorkloadLimiter } from "../../src/shared/workload-limiter.js";
import type { WorkloadLease } from "../../src/shared/workload-limiter.js";

const admitted = (result: ReturnType<WorkloadLimiter["tryAcquire"]>): WorkloadLease => {
  if (!result.admitted) throw new Error(`expected admission, was rejected for scope ${result.scope}`);
  return result.lease;
};

describe("WorkloadLimiter configuration", () => {
  it.each([
    ["a zero global maximum", { maxActive: 0, maxPerUser: 1 }],
    ["a negative global maximum", { maxActive: -1, maxPerUser: 1 }],
    ["a fractional global maximum", { maxActive: 1.5, maxPerUser: 1 }],
    ["a zero per-user maximum", { maxActive: 2, maxPerUser: 0 }],
    ["a fractional per-user maximum", { maxActive: 2, maxPerUser: 0.5 }],
    ["NaN", { maxActive: Number.NaN, maxPerUser: 1 }],
    ["a per-user maximum above the global maximum", { maxActive: 2, maxPerUser: 3 }],
  ])("rejects %s", (_label, limits) => {
    expect(() => new WorkloadLimiter(limits)).toThrow(RangeError);
  });

  it("accepts a per-user maximum equal to the global maximum", () => {
    expect(() => new WorkloadLimiter({ maxActive: 2, maxPerUser: 2 })).not.toThrow();
  });
});

describe("WorkloadLimiter admission", () => {
  it("admits up to the global maximum from distinct users, then rejects without waiting", () => {
    const limiter = new WorkloadLimiter({ maxActive: 3, maxPerUser: 1 });
    const leases = ["a", "b", "c"].map((user) => admitted(limiter.tryAcquire(user)));

    expect(limiter.activeCount).toBe(3);
    expect(limiter.tryAcquire("d")).toEqual({ admitted: false, scope: "global" });
    expect(limiter.activeCount).toBe(3);
    leases.forEach((lease) => lease.release());
  });

  it("rejects one user's excess while another user can still use the remaining capacity", () => {
    const limiter = new WorkloadLimiter({ maxActive: 4, maxPerUser: 2 });
    admitted(limiter.tryAcquire("a"));
    admitted(limiter.tryAcquire("a"));

    expect(limiter.tryAcquire("a")).toEqual({ admitted: false, scope: "user" });
    expect(limiter.tryAcquire("b").admitted).toBe(true);
    expect(limiter.activeCount).toBe(3);
  });

  it("frees capacity on release, and a lease releases only once", () => {
    const limiter = new WorkloadLimiter({ maxActive: 2, maxPerUser: 1 });
    const first = admitted(limiter.tryAcquire("a"));
    admitted(limiter.tryAcquire("b"));

    first.release();
    first.release();
    first.release();

    expect(limiter.activeCount).toBe(1);
    const replacement = limiter.tryAcquire("c");
    expect(replacement.admitted).toBe(true);
    // The repeated releases above must not have freed anyone else's slot.
    expect(limiter.tryAcquire("d")).toEqual({ admitted: false, scope: "global" });
  });

  it("forgets users with no active work", () => {
    const limiter = new WorkloadLimiter({ maxActive: 10, maxPerUser: 2 });
    const leases = Array.from({ length: 5 }, (_, index) => admitted(limiter.tryAcquire(`user-${index}`)));
    expect(limiter.trackedUsers).toBe(5);

    leases.forEach((lease) => lease.release());

    expect(limiter.trackedUsers).toBe(0);
    expect(limiter.activeCount).toBe(0);
  });

  it("keeps a user tracked while any of their leases is still held", () => {
    const limiter = new WorkloadLimiter({ maxActive: 4, maxPerUser: 2 });
    const first = admitted(limiter.tryAcquire("a"));
    const second = admitted(limiter.tryAcquire("a"));

    first.release();
    expect(limiter.trackedUsers).toBe(1);
    expect(limiter.tryAcquire("a").admitted).toBe(true);
    second.release();
  });
});

describe("OverloadedError", () => {
  it("carries a safe user message and its own code", () => {
    const error = new OverloadedError();

    expect(error.code).toBe("OVERLOADED");
    expect(error.message).toMatch(/busy/i);
    expect(error.message).toMatch(/shortly|moment/i);
  });
});
