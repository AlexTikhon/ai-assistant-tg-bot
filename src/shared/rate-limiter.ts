import { RateLimitError } from "./errors.js";

export type RateLimitOptions = {
  /** Operations allowed per key within the window. */
  limit: number;
  windowMs: number;
  /** Clock in milliseconds; injectable so tests never wait. */
  now?: () => number;
};

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * In-memory sliding-window limiter, keyed by an arbitrary string (a Telegram user id).
 *
 * Each key keeps at most `limit` timestamps. Idle keys are swept at most once per window while other
 * keys are being checked, so memory is bounded by the users active within the last window and no
 * timers are needed.
 *
 * State lives in memory and is per process: it resets when the bot restarts (a restart grants every user a
 * fresh allowance) and would not be shared between several instances. That is a deliberate fit for the
 * single-process, long-polling bot; a shared store (e.g. Redis) would only have to implement `check`.
 * The limiter knows nothing about Telegram - handlers reach it through the middleware in telegram/rate-limit.ts -
 * and takes its clock as an option, so tests advance time without waiting.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private lastSweep: number;

  constructor(private readonly options: RateLimitOptions) {
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      throw new RangeError("limit must be a positive integer");
    }
    if (!(options.windowMs > 0)) {
      throw new RangeError("windowMs must be positive");
    }
    this.now = options.now ?? Date.now;
    this.lastSweep = this.now();
  }

  /** Number of keys currently remembered (for tests and diagnostics). */
  get trackedKeys() {
    return this.hits.size;
  }

  /** Records an operation if the key is under its limit. Rejected attempts are not recorded. */
  check(key: string): RateLimitResult {
    const now = this.now();
    this.sweep(now);

    const windowStart = now - this.options.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

    if (recent.length >= this.options.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: recent[0] + this.options.windowMs - now };
    }

    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }

  /** Like `check`, but throws a RateLimitError (safe to show to the user) when over the limit. */
  assertAllowed(key: string) {
    const result = this.check(key);
    if (!result.allowed) {
      throw new RateLimitError(result.retryAfterMs);
    }
  }

  private sweep(now: number) {
    if (now - this.lastSweep < this.options.windowMs) {
      return;
    }

    this.lastSweep = now;
    const windowStart = now - this.options.windowMs;
    for (const [key, timestamps] of this.hits) {
      if (timestamps[timestamps.length - 1] <= windowStart) {
        this.hits.delete(key);
      }
    }
  }
}
