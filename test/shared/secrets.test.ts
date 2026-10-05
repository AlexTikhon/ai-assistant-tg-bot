import type { Context } from "telegraf";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCliFailure } from "../../src/cli/run-cli.js";
import { ExternalServiceError } from "../../src/shared/errors.js";
import { createLogger, scrubSecrets } from "../../src/shared/logger.js";
import { clearRegisteredSecrets, describeErrorSafely, registerSecret, scrubDeep } from "../../src/shared/scrub.js";
import { startBot } from "../../src/startup.js";
import { downloadTelegramFile } from "../../src/telegram/download.js";

const OPENAI_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const BOT_TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1";
const FILE_URL = `https://api.telegram.org/file/bot${BOT_TOKEN}/documents/file_17.pdf`;

afterEach(() => clearRegisteredSecrets());

function capture(level = "info") {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ write: (line: string) => void lines.push(JSON.parse(line)) }, level);
  return { logger, lines, text: () => JSON.stringify(lines) };
}

describe("scrubSecrets", () => {
  it("OpenAI keys of every common shape", () => {
    for (const key of [OPENAI_KEY, "sk-abcdefghijklmnopqrstuvwxyz123456", "sk-svcacct-AAAA_bbbb-CCCC_dddd-1234"]) {
      expect(scrubSecrets(`Incorrect API key provided: ${key}. You can find your API key at ...`)).not.toContain(key.slice(4));
    }
    expect(scrubSecrets(`key=${OPENAI_KEY}`)).toContain("[redacted-api-key]");
  });

  it("Telegram bot tokens", () => {
    expect(scrubSecrets(`token ${BOT_TOKEN} was rejected`)).toBe("token [redacted-telegram-token] was rejected");
  });

  it("Telegram file download URLs - the token in the path goes, the rest of the URL stays readable", () => {
    const text = scrubSecrets(`Telegram file download failed: GET ${FILE_URL} -> 500`);

    expect(text).not.toContain(BOT_TOKEN);
    expect(text).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1");
    expect(text).toContain("https://api.telegram.org/file/bot[redacted-telegram-token]/documents/file_17.pdf");
  });

  it("Authorization headers and bearer tokens", () => {
    expect(scrubSecrets("Authorization: Bearer abcDEF123456.ghi-jkl_mno")).not.toContain("abcDEF123456");
    expect(scrubSecrets("headers: { authorization: 'Bearer abcDEF123456xyz' }")).not.toContain("abcDEF123456xyz");
  });

  it("the configuration variables as they appear in an .env line", () => {
    const text = scrubSecrets(`OPENAI_API_KEY=notakeyshape12345\nTELEGRAM_BOT_TOKEN="whatever-value-here"\nDATA_DIR=./data`);

    expect(text).not.toContain("notakeyshape12345");
    expect(text).not.toContain("whatever-value-here");
    expect(text).toContain("DATA_DIR=./data");
  });

  it("keeps configuration validation messages readable: 'NAME: Invalid input' contains no secret", () => {
    const message = "Invalid configuration:\n- OPENAI_API_KEY: Invalid input: expected string, received undefined\n- TELEGRAM_BOT_TOKEN: Too small";

    expect(scrubSecrets(message)).toBe(message);
  });

  it("a registered secret of any shape, wherever it appears", () => {
    registerSecret("hunter2-but-longer");

    expect(scrubSecrets("password is hunter2-but-longer, really")).toBe("password is [redacted], really");
  });

  it("does not register something short enough to destroy ordinary words", () => {
    registerSecret("the");

    expect(scrubSecrets("the cat")).toBe("the cat");
  });

  it("leaves ordinary text alone", () => {
    const text = "Document ingested: 12 chunks in 340 ms (id 3b95f056-90a1-4482-a153-f2c09b4f3875)";

    expect(scrubSecrets(text)).toBe(text);
  });
});

describe("scrubDeep and describeErrorSafely", () => {
  it("scrubs strings inside nested objects, arrays, URL objects and error causes", () => {
    const scrubbed = JSON.stringify(
      scrubDeep({ url: new URL(FILE_URL), nested: [{ message: `bad key ${OPENAI_KEY}` }], headers: { Authorization: "Bearer abcdef123456", "x-ok": "fine" } }),
    );

    expect(scrubbed).not.toContain(BOT_TOKEN);
    expect(scrubbed).not.toContain(OPENAI_KEY);
    expect(scrubbed).not.toContain("abcdef123456");
    expect(scrubbed).toContain("fine");
  });

  it("survives cycles", () => {
    const loop: Record<string, unknown> = { token: BOT_TOKEN };
    loop.self = loop;

    expect(JSON.stringify(scrubDeep(loop))).not.toContain(BOT_TOKEN);
  });

  it("describes an error and its causes without a stack and without secrets", () => {
    const error = new Error(`outer ${OPENAI_KEY}`, { cause: new TypeError(`inner ${FILE_URL}`) });

    const text = describeErrorSafely(error);

    expect(text).toContain("outer [redacted-api-key]");
    expect(text).toContain("inner https://api.telegram.org/file/bot[redacted-telegram-token]");
    expect(text).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);
  });
});

describe("structured logs", () => {
  it("an error's message, stack, properties and causes are scrubbed", () => {
    const { logger, text } = capture();
    const error = Object.assign(new Error(`failed with ${OPENAI_KEY}`, { cause: new Error(`GET ${FILE_URL}`) }), { url: FILE_URL, config: { headers: { Authorization: `Bearer ${OPENAI_KEY}` } } });

    logger.error({ err: error }, "Update failed");

    expect(text()).not.toContain(BOT_TOKEN);
    expect(text()).not.toContain(OPENAI_KEY);
    expect(text()).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(text()).toContain("[redacted");
  });

  it("any field of any log line is scrubbed, not only errors", () => {
    const { logger, text } = capture();

    logger.info({ link: FILE_URL, detail: { note: `key ${OPENAI_KEY}` }, apiKey: OPENAI_KEY, headers: { authorization: "Bearer abcdef123456" } }, "something happened");

    expect(text()).not.toContain(BOT_TOKEN);
    expect(text()).not.toContain(OPENAI_KEY);
    expect(text()).not.toContain("abcdef123456");
  });

  it("a registered secret is removed from a log line whatever it looks like", () => {
    registerSecret("an-unusual-secret-value");
    const { logger, text } = capture();

    logger.warn({ reason: "upstream said an-unusual-secret-value is invalid" }, "rejected");

    expect(text()).not.toContain("an-unusual-secret-value");
  });

  it("the error serializer still produces the usual structure", () => {
    const { logger, lines } = capture();

    logger.error({ err: new TypeError("plain failure") }, "failed");

    expect(lines[0].err).toMatchObject({ type: "TypeError", message: "plain failure" });
  });
});

describe("startup errors", () => {
  it("a configuration or startup failure that mentions a secret never puts it in a log line", async () => {
    const { logger, text } = capture();
    const log = { info: logger.info.bind(logger), warn: logger.warn.bind(logger), fatal: logger.fatal.bind(logger) };

    const result = await startBot({
      readConfig: () => {
        throw new Error(`Invalid configuration: TELEGRAM_BOT_TOKEN=${BOT_TOKEN} OPENAI_API_KEY=${OPENAI_KEY}`);
      },
      createApplication: () => {
        throw new Error("unreachable");
      },
      runApplication: async () => {
        throw new Error("unreachable");
      },
      log,
    });

    expect(result.exitCode).toBe(1);
    expect(text()).not.toContain(BOT_TOKEN);
    expect(text()).not.toContain(OPENAI_KEY);
  });
});

describe("command-line output", () => {
  it("an unexpected failure is printed as one scrubbed message, never as a stack", () => {
    const text = formatCliFailure(new Error(`could not authenticate with ${OPENAI_KEY}`, { cause: new Error(`via ${FILE_URL}`) }));

    expect(text).not.toContain(OPENAI_KEY);
    expect(text).not.toContain(BOT_TOKEN);
    expect(text.split("\n")).toHaveLength(1);
  });

  it("a damaged database adds what to do about it", () => {
    const text = formatCliFailure(Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" }));

    expect(text).toMatch(/restore/);
    expect(text).toMatch(/backup:verify/);
  });
});

describe("the Telegram file URL (it contains the bot token)", () => {
  const ctx = { telegram: { getFileLink: async () => new URL(FILE_URL) } } as unknown as Context;
  const limits = { maxBytes: 1000, timeoutMs: 1000 };
  const retry = { sleep: async () => undefined, baseDelayMs: 1 };

  it("a failed download tells the user a generic message and carries no URL; logging the cause scrubs the token", async () => {
    const failing = vi.fn().mockRejectedValue(new TypeError(`fetch failed: request to ${FILE_URL} failed, reason: socket hang up`));
    const { logger, text } = capture();

    const error = await downloadTelegramFile(ctx, "file-1", limits, { fetchImpl: failing as unknown as typeof fetch, retry }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error as Error).message).not.toContain("telegram.org");
    expect((error as Error).message).not.toContain(BOT_TOKEN);
    logger.error({ err: error }, "Update failed"); // what the error boundary does with it
    expect(text()).not.toContain(BOT_TOKEN);
    expect(text()).toContain("[redacted-telegram-token]");
  });

  it("an HTTP error status is reported without the URL", async () => {
    const notFound = vi.fn().mockResolvedValue(new Response("nope", { status: 404 }));

    const error = await downloadTelegramFile(ctx, "file-1", limits, { fetchImpl: notFound as unknown as typeof fetch, retry }).catch((e: unknown) => e);
    const { logger, text } = capture();
    logger.error({ err: error }, "Update failed");

    expect(text()).not.toContain(BOT_TOKEN);
  });
});
