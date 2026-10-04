import { describe, expect, it, vi } from "vitest";
import { classifyFailure, HttpStatusError, withRetry } from "../../src/shared/retry.js";

/** A sleep that records instead of waiting. */
function fakeSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

const failing = (status: number, extra: Partial<ConstructorParameters<typeof HttpStatusError>[1]> = {}) => new HttpStatusError(`status ${status}`, { status, ...extra });

describe("classifyFailure", () => {
  it.each([429, 500, 502, 503, 504, 529, 408])("HTTP %i is transient", (status) => {
    expect(classifyFailure(failing(status)).retryable).toBe(true);
  });

  it.each([400, 401, 403, 404, 409, 413, 422, 501])("HTTP %i is not worth repeating", (status) => {
    expect(classifyFailure(failing(status)).retryable).toBe(false);
  });

  it("recognises the status of an OpenAI-SDK-style error and of a Telegram API error", () => {
    expect(classifyFailure(Object.assign(new Error("rate limited"), { status: 429 })).retryable).toBe(true);
    expect(classifyFailure(Object.assign(new Error("forbidden"), { status: 403 })).retryable).toBe(false);
    expect(classifyFailure(Object.assign(new Error("Too Many Requests"), { response: { error_code: 429, parameters: { retry_after: 3 } } }))).toEqual({
      retryable: true,
      retryAfterMs: 3000,
    });
    expect(classifyFailure(Object.assign(new Error("Unauthorized"), { response: { error_code: 401 } })).retryable).toBe(false);
  });

  it("reads Retry-After in seconds from the error or from response headers", () => {
    expect(classifyFailure(failing(429, { retryAfterMs: 2500 })).retryAfterMs).toBe(2500);
    expect(classifyFailure(Object.assign(new Error("x"), { status: 429, headers: { "retry-after": "4" } })).retryAfterMs).toBe(4000);
    expect(classifyFailure(Object.assign(new Error("x"), { status: 503, headers: new Headers({ "retry-after": "2" }) })).retryAfterMs).toBe(2000);
  });

  it.each(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"])("the network error %s is transient, also when it is the cause", (code) => {
    expect(classifyFailure(Object.assign(new Error("boom"), { code })).retryable).toBe(true);
    expect(classifyFailure(new TypeError("fetch failed", { cause: Object.assign(new Error("inner"), { code }) })).retryable).toBe(true);
  });

  it("a timeout is transient, a caller's abort is not", () => {
    expect(classifyFailure(new DOMException("timed out", "TimeoutError")).retryable).toBe(true);
    expect(classifyFailure(new DOMException("aborted", "AbortError")).retryable).toBe(false);
  });

  it("anything else (validation errors, bugs, unknown failures) is not retried", () => {
    expect(classifyFailure(new Error("The file is empty")).retryable).toBe(false);
    expect(classifyFailure(new TypeError("x is not a function")).retryable).toBe(false);
    expect(classifyFailure("a string").retryable).toBe(false);
  });
});

describe("withRetry", () => {
  it("retries a transient 429 and returns the eventual result", async () => {
    const { sleep, delays } = fakeSleep();
    const operation = vi.fn().mockRejectedValueOnce(failing(429)).mockResolvedValueOnce("ok");

    await expect(withRetry(operation, { sleep })).resolves.toBe("ok");

    expect(operation).toHaveBeenCalledTimes(2);
    expect(delays).toHaveLength(1);
  });

  it("retries 5xx responses and network resets", async () => {
    const { sleep } = fakeSleep();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(failing(503))
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce("ok");

    await expect(withRetry(operation, { sleep, maxAttempts: 3 })).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 401: one call, the original error", async () => {
    const { sleep, delays } = fakeSleep();
    const error = failing(401);
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withRetry(operation, { sleep })).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("does not retry validation errors or 403s either", async () => {
    const { sleep } = fakeSleep();
    for (const error of [failing(403), new Error("validation failed")]) {
      const operation = vi.fn().mockRejectedValue(error);
      await expect(withRetry(operation, { sleep })).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
    }
  });

  it("stops at the maximum number of attempts and rethrows the last error", async () => {
    const { sleep, delays } = fakeSleep();
    const last = failing(503);
    const operation = vi.fn().mockRejectedValueOnce(failing(500)).mockRejectedValueOnce(failing(502)).mockRejectedValue(last);

    await expect(withRetry(operation, { sleep, maxAttempts: 3 })).rejects.toBe(last);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toHaveLength(2); // no sleep after the last attempt
  });

  it("a single attempt means no retry at all", async () => {
    const operation = vi.fn().mockRejectedValue(failing(503));

    await expect(withRetry(operation, { maxAttempts: 1, sleep: fakeSleep().sleep })).rejects.toBeInstanceOf(HttpStatusError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("waits longer each time (exponential), never more than the cap", async () => {
    const { sleep, delays } = fakeSleep();
    const operation = vi.fn().mockRejectedValue(failing(503));

    await withRetry(operation, { sleep, maxAttempts: 6, baseDelayMs: 100, maxDelayMs: 500, random: () => 0 }).catch(() => undefined);

    expect(delays).toEqual([100, 200, 400, 500, 500]);
  });

  it("adds at most 25% jitter", async () => {
    const { sleep, delays } = fakeSleep();

    await withRetry(vi.fn().mockRejectedValue(failing(503)), { sleep, maxAttempts: 2, baseDelayMs: 100, random: () => 1 }).catch(() => undefined);

    expect(delays).toEqual([125]);
  });

  it("honours the provider's Retry-After instead of its own backoff", async () => {
    const { sleep, delays } = fakeSleep();
    const operation = vi.fn().mockRejectedValueOnce(failing(429, { retryAfterMs: 2000 })).mockResolvedValueOnce("ok");

    await withRetry(operation, { sleep, baseDelayMs: 100 });

    expect(delays).toEqual([2000]);
  });

  it("gives up at once when the provider asks for a wait longer than it is willing to hold a user's request", async () => {
    const { sleep } = fakeSleep();
    const error = failing(429, { retryAfterMs: 120_000 });
    const operation = vi.fn().mockRejectedValue(error);

    await expect(withRetry(operation, { sleep, maxRetryAfterMs: 10_000 })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("an abort while waiting stops the retries immediately with the abort reason", async () => {
    const controller = new AbortController();
    const operation = vi.fn().mockRejectedValue(failing(503));
    const sleep = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        controller.abort(new DOMException("cancelled", "AbortError")); // the user gives up during the backoff
        signal?.addEventListener("abort", () => reject(signal.reason));
        if (signal?.aborted) reject(signal.reason);
      });

    await expect(withRetry(operation, { sleep, signal: controller.signal, maxAttempts: 5 })).rejects.toMatchObject({ name: "AbortError" });

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("an already aborted signal never starts the operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn();

    await expect(withRetry(operation, { signal: controller.signal })).rejects.toBeDefined();
    expect(operation).not.toHaveBeenCalled();
  });

  it("passes the attempt number and the signal to the operation, and reports retries", async () => {
    const { sleep } = fakeSleep();
    const onRetry = vi.fn();
    const seen: number[] = [];
    const controller = new AbortController();

    await withRetry(
      async (attempt, signal) => {
        seen.push(attempt);
        expect(signal).toBe(controller.signal);
        if (attempt < 2) throw failing(503);
        return "done";
      },
      { sleep, onRetry, signal: controller.signal },
    );

    expect(seen).toEqual([1, 2]);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: expect.any(Number) }));
  });

  it("the real sleep is abortable and short sleeps really wait", async () => {
    const started = Date.now();
    await withRetry(vi.fn().mockRejectedValueOnce(failing(503)).mockResolvedValueOnce("ok"), { baseDelayMs: 20, random: () => 0 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    await expect(withRetry(vi.fn().mockRejectedValue(failing(503)), { baseDelayMs: 5000, signal: controller.signal })).rejects.toBeDefined();
  });
});
