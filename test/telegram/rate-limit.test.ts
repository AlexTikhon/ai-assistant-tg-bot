import type { Context } from "telegraf";
import { describe, expect, it } from "vitest";
import { RateLimitError, ValidationError } from "../../src/shared/errors.js";
import { RateLimiter } from "../../src/shared/rate-limiter.js";
import { createRateLimitMiddleware } from "../../src/telegram/rate-limit.js";

const ctx = (userId: number | undefined, text?: string) =>
  ({ from: userId === undefined ? undefined : { id: userId }, message: text === undefined ? {} : { text } }) as unknown as Context;

function setup(limit = 2) {
  let now = 0;
  const limiter = new RateLimiter({ limit, windowMs: 60_000, now: () => now });
  return { middleware: createRateLimitMiddleware(limiter), advance: (ms: number) => (now += ms) };
}

describe("createRateLimitMiddleware", () => {
  it("lets requests through until the user's limit is reached, then throws a friendly RateLimitError", async () => {
    const { middleware } = setup(2);
    let handled = 0;
    const next = async () => void (handled += 1);

    await middleware(ctx(1), next);
    await middleware(ctx(1), next);
    await expect(middleware(ctx(1), next)).rejects.toThrow(RateLimitError);

    expect(handled).toBe(2);
  });

  it("limits each Telegram user separately", async () => {
    const { middleware } = setup(1);
    const next = async () => undefined;

    await middleware(ctx(1), next);
    await expect(middleware(ctx(2), next)).resolves.toBeUndefined();
    await expect(middleware(ctx(1), next)).rejects.toThrow(RateLimitError);
  });

  it("allows requests again after the window, without any real waiting", async () => {
    const { middleware, advance } = setup(1);
    const next = async () => undefined;
    await middleware(ctx(1), next);
    await expect(middleware(ctx(1), next)).rejects.toThrow(/seconds/);

    advance(60_001);

    await expect(middleware(ctx(1), next)).resolves.toBeUndefined();
  });

  it("does not count slash commands sent as plain text when skipCommands is on", async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, now: () => 0 });
    const middleware = createRateLimitMiddleware(limiter, { skipCommands: true });
    const next = async () => undefined;

    await middleware(ctx(1, "/unknown"), next);
    await middleware(ctx(1, "/unknown"), next);
    await middleware(ctx(1, "a question"), next);
    await expect(middleware(ctx(1, "another question"), next)).rejects.toThrow(RateLimitError);
  });

  it("refuses updates without a user instead of sharing one bucket", async () => {
    const { middleware } = setup();

    await expect(middleware(ctx(undefined), async () => undefined)).rejects.toThrow(ValidationError);
  });
});
