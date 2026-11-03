import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { boundOutput, MAX_GENERATED_TEXT_CHARS, OUTPUT_TRUNCATED_NOTICE } from "../../src/shared/output-budget.js";
import { readTextContent } from "../../src/infrastructure/openai/response-text.js";

describe("output budgets", () => {
  it("keeps normal text unchanged, and discloses truncation within the character bound", () => {
    expect(boundOutput("answer [1]")).toBe("answer [1]");
    const bounded = boundOutput("x".repeat(200_000));
    expect(bounded.length).toBeLessThanOrEqual(MAX_GENERATED_TEXT_CHARS);
    expect(bounded).toContain(OUTPUT_TRUNCATED_NOTICE);
  });

  it("keeps surrogate pairs and complete citations, dropping a reference cut midway", () => {
    const available = 100 - OUTPUT_TRUNCATED_NOTICE.length;
    const prefix = "a".repeat(available - 3);
    expect(boundOutput(prefix + "[1, 2]" + "z".repeat(100), 100)).toBe(prefix + OUTPUT_TRUNCATED_NOTICE);
    const emoji = boundOutput("😀".repeat(100), 100);
    expect(emoji).toMatch(/^😀+\n\n\[Response shortened/u);
    expect(emoji.length).toBeLessThanOrEqual(100);
  });

  it("normalizes oversized content arrays without reading or joining their whole tail", () => {
    const unread = { get text(): string { throw new Error("the discarded tail was read"); } };
    const text = readTextContent([{ type: "text", text: "x".repeat(200_000) }, unread]);
    expect(text.length).toBeLessThanOrEqual(MAX_GENERATED_TEXT_CHARS);
    expect(text).toContain(OUTPUT_TRUNCATED_NOTICE);
  });

  it("validates the provider token budget and applies its default", () => {
    const env = { TELEGRAM_BOT_TOKEN: "test", OPENAI_API_KEY: "test" };
    expect(loadConfig(env).openai.chatMaxOutputTokens).toBe(2048);
    expect(loadConfig({ ...env, CHAT_MAX_OUTPUT_TOKENS: "4096" }).openai.chatMaxOutputTokens).toBe(4096);
    for (const value of ["0", "-1", "1.5", "8193", "bad"]) {
      expect(() => loadConfig({ ...env, CHAT_MAX_OUTPUT_TOKENS: value })).toThrow(/CHAT_MAX_OUTPUT_TOKENS/);
    }
  });
});
