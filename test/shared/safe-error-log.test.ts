import http from "node:http";
import type { AddressInfo } from "node:net";
import { APIError } from "openai";
import { Telegraf } from "telegraf";
import { TelegramError } from "telegraf";
import { afterEach, describe, expect, it } from "vitest";
import { AppError, ExternalServiceError, NotFoundError, StartupError } from "../../src/shared/errors.js";
import { createLogger } from "../../src/shared/logger.js";
import { runWithRequestId } from "../../src/shared/request-context.js";
import { clearRegisteredSecrets, registerSecret } from "../../src/shared/scrub.js";

const PRIVATE = "SYNTHETIC_PRIVATE_ANSWER_DO_NOT_LOG";
const RAW_CHAT_ID = 5551234567;
const OPENAI_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const BOT_TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";

afterEach(() => clearRegisteredSecrets());

function capture(level = "info") {
  const lines: Array<Record<string, any>> = [];
  const logger = createLogger({ write: (line: string) => void lines.push(JSON.parse(line)) }, level);
  return { logger, lines, text: () => lines.map((line) => JSON.stringify(line)).join("\n"), err: () => lines[0].err as Record<string, any> };
}

/** Depth of the nested `cause` records of a serialized error. */
function causeDepth(err: Record<string, any> | undefined): number {
  let depth = 0;
  for (let node = err?.cause; node && typeof node === "object"; node = node.cause) depth += 1;
  return depth;
}

describe("a failed Telegram send (real TelegramError)", () => {
  const failedSend = () =>
    new TelegramError(
      { error_code: 429, description: `Too Many Requests: ${PRIVATE}`, parameters: { retry_after: 1 } },
      {
        method: "sendMessage",
        payload: {
          chat_id: RAW_CHAT_ID,
          text: PRIVATE,
          caption: `${PRIVATE}-caption`,
          reply_markup: { inline_keyboard: [[{ text: `${PRIVATE}-button`, callback_data: `fb:${RAW_CHAT_ID}` }]] },
          from: { id: RAW_CHAT_ID + 1 },
        },
      },
    );

  it("writes neither the answer, the caption, the markup nor any raw Telegram identifier anywhere in the line", () => {
    const { logger, text } = capture();

    logger.error({ err: failedSend(), userId: RAW_CHAT_ID }, "Update failed");

    expect(text()).not.toContain(PRIVATE);
    expect(text()).not.toContain(String(RAW_CHAT_ID));
    expect(text()).not.toContain(String(RAW_CHAT_ID + 1));
    expect(text()).not.toContain("Too Many Requests");
    expect(text()).not.toContain("inline_keyboard");
  });

  it("keeps what an operator needs: category, service, method, status and the retry delay", () => {
    const { logger, err, lines } = capture();

    logger.error({ err: failedSend(), userId: RAW_CHAT_ID }, "Update failed");

    expect(err()).toEqual({ category: "external", type: "TelegramError", service: "telegram", method: "sendMessage", status: 429, retryAfterSec: 1 });
    expect(lines[0].user).toMatch(/^u-[0-9a-f]{8}$/);
  });

  it("an unknown method, an out-of-range status and a huge retry delay are dropped, not copied", () => {
    const { logger, err } = capture();
    const odd = new TelegramError({ error_code: 99999, description: PRIVATE, parameters: { retry_after: 1e12 } }, { method: PRIVATE, payload: {} });

    logger.error({ err: odd }, "Update failed");

    expect(err()).toEqual({ category: "external", type: "TelegramError", service: "telegram" });
  });
});

describe("a failed send through the real Telegraf client (loopback Bot API)", () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it("the error Telegraf produces from a 429 reply is logged without the answer or the chat id", async () => {
    server = http.createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error_code: 429, description: `Too Many Requests: retry after 1 ${PRIVATE}`, parameters: { retry_after: 1 } }));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const bot = new Telegraf("123456:SYNTHETIC_LOOPBACK_TOKEN_0000000000000", { telegram: { apiRoot } });

    const error = await bot.telegram.sendMessage(RAW_CHAT_ID, PRIVATE).catch((e: unknown) => e);

    // The installed SDK really does attach the request to the error - which is why the logger must not copy it.
    expect(error).toBeInstanceOf(TelegramError);
    expect(JSON.stringify((error as TelegramError).on)).toContain(PRIVATE);
    const { logger, err, text } = capture();
    logger.error({ err: error, userId: RAW_CHAT_ID }, "Update failed");

    expect(text()).not.toContain(PRIVATE);
    expect(text()).not.toContain(String(RAW_CHAT_ID));
    expect(err()).toMatchObject({ category: "external", service: "telegram", method: "sendMessage", status: 429, retryAfterSec: 1 });
  });
});

describe("provider errors", () => {
  it("an ExternalServiceError around an OpenAI error keeps service, status and code but no request, response or message text", () => {
    const providerError = APIError.generate(
      429,
      { error: { message: `quota exceeded for ${PRIVATE}-response`, code: "rate_limit_exceeded", type: "requests" }, request: { messages: [{ role: "user", content: `${PRIVATE}-prompt` }] } },
      `429 ${PRIVATE}-message document excerpt: ${PRIVATE}-excerpt`,
      new Headers({ "x-request-id": `${PRIVATE}-header`, "retry-after": "3" }),
    );
    Object.assign(providerError, { input: [`${PRIVATE}-input`] });
    const wrapped = new ExternalServiceError("openai", { cause: providerError });
    const { logger, err, text } = capture();

    logger.error({ err: wrapped }, "Update failed");

    expect(text()).not.toContain(PRIVATE);
    expect(err()).toMatchObject({ category: "external", type: "ExternalServiceError", code: "EXTERNAL_SERVICE_ERROR", service: "openai" });
    expect(err().cause).toMatchObject({ category: "external", type: "RateLimitError", status: 429, code: "rate_limit_exceeded" });
  });

  it("a network failure keeps its known system code", () => {
    const reset = Object.assign(new TypeError(`fetch failed ${PRIVATE}`, { cause: Object.assign(new Error(`read ECONNRESET ${PRIVATE}`), { code: "ECONNRESET", syscall: "read", address: "10.0.0.1" }) }));
    const { logger, err, text } = capture();

    logger.error({ err: new ExternalServiceError("telegram", { cause: reset }) }, "Update failed");

    expect(text()).not.toContain(PRIVATE);
    expect(text()).not.toContain("10.0.0.1");
    expect(err().cause.cause).toMatchObject({ category: "network", code: "ECONNRESET" });
  });

  it("a SQLite error keeps its known code and is a storage failure", () => {
    const sqlite = Object.assign(new Error(`UNIQUE constraint failed: documents.name (${PRIVATE})`), { name: "SqliteError", code: "SQLITE_CONSTRAINT_UNIQUE" });
    const { logger, err, text } = capture();

    logger.error({ err: sqlite }, "Update failed");

    expect(text()).not.toContain(PRIVATE);
    expect(err()).toEqual({ category: "storage", type: "SqliteError", code: "SQLITE_CONSTRAINT_UNIQUE" });
  });
});

describe("application and startup errors", () => {
  it("an application rejection keeps its code but not its (user-facing) message", () => {
    const { logger, err, text } = capture();

    logger.warn({ err: new AppError(`Sorry, ${PRIVATE}`, "VALIDATION_ERROR"), updateType: "message" }, "Update rejected");

    expect(text()).not.toContain(PRIVATE);
    expect(err()).toEqual({ category: "application", type: "AppError", code: "VALIDATION_ERROR" });
  });

  it("a subclass keeps its name; a message that is no business of the log is gone", () => {
    const { logger, err } = capture();

    logger.warn({ err: new NotFoundError(PRIVATE) }, "Update rejected");

    expect(err()).toEqual({ category: "application", type: "NotFoundError", code: "NOT_FOUND" });
  });

  it("a startup error keeps its stage and the safe category of its cause, not the cause's message", () => {
    const sqlite = Object.assign(new Error(`file is not a database: /home/alex/${PRIVATE}/app.db`), { name: "SqliteError", code: "SQLITE_NOTADB" });
    const { logger, err, text } = capture();

    logger.fatal({ err: new StartupError("database", sqlite, "restore a backup") }, "Startup failed");

    expect(text()).not.toContain(PRIVATE);
    expect(text()).not.toContain("/home/alex");
    expect(err()).toMatchObject({ category: "startup", type: "StartupError", stage: "database", cause: { category: "storage", code: "SQLITE_NOTADB" } });
  });
});

describe("whatever else is thrown", () => {
  it("an unknown Error is an unknown Error: no message, no stack, no extra properties", () => {
    const error = Object.assign(new Error(`${PRIVATE} message`), { detail: `${PRIVATE}-detail`, url: `https://example.test/${PRIVATE}?q=1`, path: `/home/u/${PRIVATE}.pdf` });
    error.stack = `Error: ${PRIVATE} first line\n    at secret (/home/u/${PRIVATE}.ts:1:1)`;
    const { logger, err, text } = capture();

    logger.error({ err: error }, "failed");

    expect(text()).not.toContain(PRIVATE);
    expect(text()).not.toContain("stack");
    expect(err()).toEqual({ category: "unknown", type: "Error" });
  });

  it.each([
    ["a string", PRIVATE],
    ["a plain object", { message: PRIVATE, code: PRIVATE, response: { description: PRIVATE } }],
    ["an array", [PRIVATE]],
    ["a number", RAW_CHAT_ID],
    ["null", null],
  ])("%s that was thrown is only described by its kind", (_label, thrown) => {
    const { logger, err, text } = capture();

    logger.error({ err: thrown }, "failed");

    expect(text()).not.toContain(PRIVATE);
    expect(text()).not.toContain(String(RAW_CHAT_ID));
    expect(err().category).toBe("unknown");
  });

  it("attacker- or data-controlled name, code, service, method and status values are not copied", () => {
    const hostile = Object.assign(new Error("x"), { name: `${PRIVATE}Error`, code: `SQLITE_${PRIVATE}`, service: PRIVATE, method: PRIVATE, status: `${PRIVATE}`, stage: PRIVATE });
    const hostileExternal = Object.assign(new ExternalServiceError("openai"), { service: `${PRIVATE}-service`, code: `${PRIVATE}-code` });
    const hostileTelegram = Object.assign(new TelegramError({ error_code: 400, description: "x" }, { method: `${PRIVATE}-method` }), { name: "TelegramError" });
    const { logger, text } = capture();

    for (const err of [hostile, hostileExternal, hostileTelegram]) logger.error({ err }, "failed");

    expect(text()).not.toContain(PRIVATE);
  });

  it("an unknown code on a known error type is dropped even when it looks like a code", () => {
    const { logger, err } = capture();

    logger.error({ err: Object.assign(new Error("x"), { code: "SQLITE_NOT_A_REAL_CODE_PRIVATE_TEXT" }) }, "failed");

    expect(err()).not.toHaveProperty("code");
  });
});

describe("malformed and hostile error graphs", () => {
  it("an error that is its own cause is logged, with a cycle marker", () => {
    const error = new Error("synthetic");
    error.cause = error;
    const { logger, err } = capture();

    expect(() => logger.error({ err: error }, "failure")).not.toThrow();

    expect(err()).toEqual({ category: "unknown", type: "Error", cause: { truncated: "cycle" } });
  });

  it("two errors that are each other's cause end in a cycle marker", () => {
    const a = new Error("a");
    const b = new TypeError("b", { cause: a });
    a.cause = b;
    const { logger, err } = capture();

    logger.error({ err: a }, "failure");

    expect(err()).toEqual({ category: "unknown", type: "Error", cause: { category: "unknown", type: "TypeError", cause: { truncated: "cycle" } } });
  });

  it("a very deep cause chain is cut at a fixed depth with a marker, in bounded output", () => {
    let error: Error = new Error("leaf");
    for (let index = 0; index < 5000; index += 1) error = new Error(`level ${index}`, { cause: error });
    const { logger, err, text } = capture();

    logger.error({ err: error }, "failure");

    expect(causeDepth(err())).toBeLessThanOrEqual(8);
    expect(text()).toContain('"truncated":"depth"');
    expect(text().length).toBeLessThan(2000);
  });

  it("a huge arbitrary property is never enumerated; custom serialization hooks are never called", () => {
    let calls = 0;
    const hook = () => {
      calls += 1;
      throw new Error("must not be called");
    };
    const error = Object.assign(new Error("x"), {
      payload: Object.fromEntries(Array.from({ length: 200_000 }, (_, index) => [`k${index}`, PRIVATE])),
      toJSON: hook,
      toString: hook,
      inspect: hook,
    });
    const { logger, err, text } = capture();

    logger.error({ err: error }, "failure");

    expect(calls).toBe(0);
    expect(err()).toEqual({ category: "unknown", type: "Error" });
    expect(text().length).toBeLessThan(1000);
  });

  it("getters that throw (name, message, code, status, cause, response) are neither invoked nor fatal", () => {
    let calls = 0;
    const boom = () => {
      calls += 1;
      throw new Error(PRIVATE);
    };
    const error = new Error("x");
    for (const key of ["name", "message", "code", "status", "cause", "response", "on", "service", "stage"]) Object.defineProperty(error, key, { get: boom, enumerable: true });
    const { logger, err, text } = capture();

    expect(() => logger.error({ err: error }, "failure")).not.toThrow();

    expect(calls).toBe(0);
    expect(text()).not.toContain(PRIVATE);
    expect(err().category).toBe("unknown");
  });

  it("a Proxy whose every trap throws, and an object with a throwing prototype lookup, do not break logging", () => {
    const trap = () => {
      throw new Error(PRIVATE);
    };
    const proxy = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    const { logger, lines, text } = capture();

    expect(() => logger.error({ err: proxy }, "failure")).not.toThrow();
    expect(() => logger.error({ err: new Error("x", { cause: proxy }) }, "failure")).not.toThrow();

    expect(lines).toHaveLength(2);
    expect(text()).not.toContain(PRIVATE);
  });
});

describe("what still works around the error", () => {
  it("secrets of any shape stay out of every line, including unusual registered ones", () => {
    registerSecret("an-unusual-secret-value");
    const { logger, text } = capture();
    const error = Object.assign(new Error(`failed with ${OPENAI_KEY} ${BOT_TOKEN} an-unusual-secret-value`), { code: "ECONNRESET", url: `https://api.telegram.org/file/bot${BOT_TOKEN}/x.pdf` });

    logger.error({ err: error, headers: { authorization: `Bearer ${OPENAI_KEY}` }, note: "an-unusual-secret-value" }, "failed");

    expect(text()).not.toContain(OPENAI_KEY);
    expect(text()).not.toContain(BOT_TOKEN);
    expect(text()).not.toContain("an-unusual-secret-value");
  });

  it("the request id of the update and child-logger fields stay on an error line, and the user is a pseudonym", () => {
    const { logger, lines, text } = capture();

    runWithRequestId("abcd1234", () => logger.child({ component: "telegram" }).error({ err: new AppError("x", "SEARCH_BUSY"), userId: RAW_CHAT_ID, durationMs: 12 }, "Update failed"));

    expect(lines[0]).toMatchObject({ requestId: "abcd1234", component: "telegram", durationMs: 12, err: { code: "SEARCH_BUSY" } });
    expect(lines[0].user).toMatch(/^u-[0-9a-f]{8}$/);
    expect(text()).not.toContain(String(RAW_CHAT_ID));
  });

  it("a line without a user gets no invented user, and a line without an error gets no err", () => {
    const { logger, lines } = capture();

    logger.error({ err: new Error("x") }, "failed");
    logger.info({ documentId: "doc-1" }, "ok");

    expect(lines[0]).not.toHaveProperty("user");
    expect(lines[1]).not.toHaveProperty("err");
  });

  it("log levels still filter", () => {
    const { logger, lines } = capture("error");

    logger.warn({ err: new Error("x") }, "dropped");
    logger.error({ err: new Error("x") }, "kept");

    expect(lines).toHaveLength(1);
  });
});
