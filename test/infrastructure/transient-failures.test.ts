import type { Context } from "telegraf";
import { describe, expect, it, vi } from "vitest";
import { OpenAISpeechToText } from "../../src/infrastructure/openai/openai-speech-to-text.js";
import { ExternalServiceError, ValidationError } from "../../src/shared/errors.js";
import { downloadTelegramFile } from "../../src/telegram/download.js";

const audio = { data: Buffer.from("audio-bytes"), fileName: "voice.ogg", mimeType: "audio/ogg" };
const noWait = { sleep: async () => undefined, baseDelayMs: 1 };

function stt(fetchImpl: ReturnType<typeof vi.fn>, retry: object = noWait) {
  return new OpenAISpeechToText({ apiKey: "sk-test-key-123456789012345", model: "m", timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch, retry });
}
const ok = () => Response.json({ text: "hello" });
const status = (code: number, headers: Record<string, string> = {}) => new Response("{}", { status: code, headers });

describe("speech-to-text retry policy", () => {
  it("retries a 429 and then succeeds, with one reply to the user", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(status(429)).mockResolvedValueOnce(ok());

    await expect(stt(fetchImpl).transcribe(audio)).resolves.toBe("hello");

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(status(503)).mockResolvedValueOnce(status(500)).mockResolvedValueOnce(ok());

    await expect(stt(fetchImpl).transcribe(audio)).resolves.toBe("hello");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("retries a network reset", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })).mockResolvedValueOnce(ok());

    await expect(stt(fetchImpl).transcribe(audio)).resolves.toBe("hello");
  });

  it("does not retry a 401 or 403: a wrong key is not going to get better", async () => {
    for (const code of [401, 403, 400]) {
      const fetchImpl = vi.fn().mockResolvedValue(status(code));

      await expect(stt(fetchImpl).transcribe(audio)).rejects.toBeInstanceOf(ExternalServiceError);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after the maximum number of attempts and reports one ExternalServiceError", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(status(503));

    const error = await stt(fetchImpl, { ...noWait, maxAttempts: 3 }).transcribe(audio).catch((e) => e);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("honours Retry-After from the provider", async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn().mockResolvedValueOnce(status(429, { "retry-after": "2" })).mockResolvedValueOnce(ok());

    await stt(fetchImpl, { sleep: async (ms: number) => void sleeps.push(ms) }).transcribe(audio);

    expect(sleeps).toEqual([2000]);
  });

  it("a response with a bad body is not retried: only transport-level failures are", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ nope: true }));

    await expect(stt(fetchImpl).transcribe(audio)).rejects.toBeInstanceOf(ExternalServiceError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("Telegram download retry policy", () => {
  const limits = { maxBytes: 1000, timeoutMs: 1000 };
  const ctx = (getFileLink = vi.fn(async () => "https://files.example/f")) => ({ telegram: { getFileLink } }) as unknown as Context;
  const body = (text: string, headers: Record<string, string> = {}) => new Response(text, { headers });

  it("retries a transient failure and returns the file", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(status(502)).mockResolvedValueOnce(body("file bytes"));

    const data = await downloadTelegramFile(ctx(), "id", limits, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: noWait });

    expect(data.toString()).toBe("file bytes");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a Telegram API 429 when asking for the file link, waiting as long as Telegram says", async () => {
    const sleeps: number[] = [];
    const getFileLink = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("Too Many Requests"), { response: { error_code: 429, parameters: { retry_after: 1 } } }))
      .mockResolvedValueOnce("https://files.example/f");
    const fetchImpl = vi.fn().mockResolvedValue(body("x"));

    await downloadTelegramFile(ctx(getFileLink), "id", limits, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: { sleep: async (ms: number) => void sleeps.push(ms) } });

    expect(sleeps).toEqual([1000]);
    expect(getFileLink).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 404, and reports the friendly message without internals", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(status(404));

    const error = await downloadTelegramFile(ctx(), "id", limits, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: noWait }).catch((e) => e);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.message).toMatch(/could not download/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("an oversized file is final: one request, a validation error, no retry", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(body("x".repeat(10), { "content-length": "5000" }));

    await expect(downloadTelegramFile(ctx(), "id", limits, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: noWait })).rejects.toBeInstanceOf(ValidationError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops after the maximum number of attempts", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(status(503));

    await expect(downloadTelegramFile(ctx(), "id", limits, { fetchImpl: fetchImpl as unknown as typeof fetch, retry: { ...noWait, maxAttempts: 2 } })).rejects.toBeInstanceOf(ExternalServiceError);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
