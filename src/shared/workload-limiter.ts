export type WorkloadLimits = {
  /** Expensive requests that may run at once in this process. */
  maxActive: number;
  /** How many of those one user may hold at once. Never above `maxActive`. */
  maxPerUser: number;
};

/** Which bound refused: the process-wide one, or the one user's own share. */
export type WorkloadRejectionScope = "global" | "user";

export type WorkloadLease = {
  /** Frees the capacity. Safe to call any number of times; only the first call has an effect. */
  release(): void;
};

export type WorkloadAdmission = { admitted: true; lease: WorkloadLease } | { admitted: false; scope: WorkloadRejectionScope };

/**
 * Fail-fast, in-memory admission of expensive work: a process-wide bound and a per-user bound, with NO waiting queue. A request
 * that does not fit is refused immediately and holds nothing, so the amount of work (and of buffered uploads, provider spend and
 * retries) the process can have in flight is bounded by configuration, not by how many users write at once.
 *
 * A lease is released by whoever holds it, once, when the work it covers has actually finished (for the bot: when the update's
 * operation has drained, see telegram/workload-admission.ts) - not when the caller stopped waiting.
 *
 * State is per process, like the rate limiter's: a deliberate fit for the single-process long-polling deployment. A user is
 * remembered only while they hold at least one lease, so memory is bounded by the number of active leases, not by history.
 * Knows nothing about Telegram; keys are opaque strings.
 */
export class WorkloadLimiter {
  private readonly perUser = new Map<string, number>();
  private active = 0;

  constructor(private readonly limits: WorkloadLimits) {
    if (!Number.isInteger(limits.maxActive) || limits.maxActive <= 0) {
      throw new RangeError("maxActive must be a positive integer");
    }
    if (!Number.isInteger(limits.maxPerUser) || limits.maxPerUser <= 0) {
      throw new RangeError("maxPerUser must be a positive integer");
    }
    if (limits.maxPerUser > limits.maxActive) {
      throw new RangeError("maxPerUser must not exceed maxActive");
    }
  }

  /** Leases currently held (for tests and diagnostics). */
  get activeCount() {
    return this.active;
  }

  /** Users that currently hold at least one lease (for tests and diagnostics). */
  get trackedUsers() {
    return this.perUser.size;
  }

  tryAcquire(userKey: string): WorkloadAdmission {
    const userActive = this.perUser.get(userKey) ?? 0;
    if (userActive >= this.limits.maxPerUser) return { admitted: false, scope: "user" };
    if (this.active >= this.limits.maxActive) return { admitted: false, scope: "global" };

    this.active += 1;
    this.perUser.set(userKey, userActive + 1);

    let released = false;
    return {
      admitted: true,
      lease: {
        release: () => {
          if (released) return;
          released = true;
          this.active -= 1;
          const remaining = (this.perUser.get(userKey) ?? 1) - 1;
          if (remaining > 0) this.perUser.set(userKey, remaining);
          else this.perUser.delete(userKey);
        },
      },
    };
  }
}
