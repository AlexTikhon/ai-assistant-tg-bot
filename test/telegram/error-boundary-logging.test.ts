import type { Context } from "telegraf";
import type * as LoggerModule from "../../src/shared/logger.js";
import { TelegramError } from "telegraf";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError, ExternalServiceError, ValidationError } from "../../src/shared/errors.js";
import { runWithRequestId } from "../../src/shared/request-context.js";
import { errorBoundary, logUnhandledError } from "../../src/telegram/middleware.js";

const written = vi.hoisted(() => [] as Array<Record<string, any>>);

// The real logger (real serializers, formatters and request correlation) writing into an array instead of stdout.
vi.mock("../../src/shared/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof LoggerModule>();
  return { ...actual, logger: actual.createLogger({ write: (line: string) => void written.push(JSON.parse(line)) }, "info") };
});

const PRIVATE = "SYNTHETIC_PRIVATE_ANSWER_DO_NOT_LOG";
const CHAT_ID = 5551234567;
const GENERIC = "Something went wrong while processing your request.";

beforeEach(() => void (written.length = 0));

const text = () => JSON.stringify(written);

function context(reply: (message: string) => Promise<unknown>) {
  return { updateType: "message", from: { id: CHAT_ID }, reply: vi.fn(reply) } as unknown as Context & { reply: ReturnType<typeof vi.fn> };
}

const failedSend = () =>
  new TelegramError({ error_code: 429, description: `Too Many Requests ${PRIVATE}`, parameters: { retry_after: 7 } }, { method: "sendMessage", payload: { chat_id: CHAT_ID, text: PRIVATE } });

describe("errorBoundary logging", () => {
  it("replies with the same generic message and logs a useful record without the payload of the failed send", async () => {
    const ctx = context(async () => undefined);

    await runWithRequestId("abcd1234", () =>
      errorBoundary(ctx, async () => {
        throw failedSend();
      }),
    );

    expect(ctx.reply).toHaveBeenCalledExactlyOnceWith(GENERIC);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      level: 50,
      msg: "Update failed",
      requestId: "abcd1234",
      component: "telegram",
      updateType: "message",
      err: { category: "external", type: "TelegramError", service: "telegram", method: "sendMessage", status: 429, retryAfterSec: 7 },
    });
    expect(written[0].user).toMatch(/^u-[0-9a-f]{8}$/);
    expect(text()).not.toContain(PRIVATE);
    expect(text()).not.toContain(String(CHAT_ID));
  });

  it("an ExternalServiceError keeps its service and the cause's category", async () => {
    const ctx = context(async () => undefined);

    await errorBoundary(ctx, async () => {
      throw new ExternalServiceError("openai", { cause: Object.assign(new Error(`echo of the question: ${PRIVATE}`), { status: 503 }) });
    });

    expect(written[0]).toMatchObject({ msg: "Update failed", err: { category: "external", service: "openai", cause: { category: "unknown", status: 503 } } });
    expect(text()).not.toContain(PRIVATE);
  });

  it("an application rejection shows the user its own message as before and logs only the code", async () => {
    const ctx = context(async () => undefined);

    await errorBoundary(ctx, async () => {
      throw new ValidationError(`The file is not supported ${PRIVATE}`);
    });

    expect(ctx.reply).toHaveBeenCalledWith(`The file is not supported ${PRIVATE}`);
    expect(written[0]).toMatchObject({ level: 40, msg: "Update rejected", code: "VALIDATION_ERROR", err: { category: "application", type: "ValidationError", code: "VALIDATION_ERROR" } });
    expect(JSON.stringify(written[0])).not.toContain(PRIVATE);
  });

  it("a failure while sending the generic reply is logged by kind too, and the first error is still logged", async () => {
    const ctx = context(async () => {
      throw failedSend();
    });

    await errorBoundary(ctx, async () => {
      throw new AppError("x", "SEARCH_BUSY");
    });
    await errorBoundary(ctx, async () => {
      throw new Error(PRIVATE);
    });

    expect(written.map((line) => line.msg)).toEqual(["Update rejected", "Could not send error reply", "Update failed", "Could not send error reply"]);
    expect(written[1].err).toMatchObject({ category: "external", method: "sendMessage", status: 429, retryAfterSec: 7 });
    expect(text()).not.toContain(PRIVATE);
    expect(text()).not.toContain(String(CHAT_ID));
  });

  it("the last-resort handler logs the same safe record", () => {
    logUnhandledError(failedSend(), { updateType: "callback_query", from: { id: CHAT_ID } } as unknown as Context);

    expect(written[0]).toMatchObject({ msg: "Unhandled bot error", updateType: "callback_query", err: { category: "external", status: 429 } });
    expect(text()).not.toContain(PRIVATE);
    expect(text()).not.toContain(String(CHAT_ID));
  });

  it("a cyclic error does not stop the boundary from replying", async () => {
    const cyclic = new Error("loop");
    cyclic.cause = cyclic;
    const ctx = context(async () => undefined);

    await errorBoundary(ctx, async () => {
      throw cyclic;
    });

    expect(ctx.reply).toHaveBeenCalledWith(GENERIC);
    expect(written[0].err).toEqual({ category: "unknown", type: "Error", cause: { truncated: "cycle" } });
  });
});
