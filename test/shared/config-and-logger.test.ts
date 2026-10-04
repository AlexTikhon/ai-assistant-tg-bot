import { describe, expect, it } from "vitest";
import { loadConfig, loadToolConfig, openAiConfig, telegramConfig } from "../../src/config/config.js";
import { scrubSecrets } from "../../src/shared/logger.js";
import { normalizeText } from "../../src/shared/utils/text.js";

const required = { TELEGRAM_BOT_TOKEN: "123456:ABCDEF", OPENAI_API_KEY: "sk-test" };

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig(required);

    expect(config.openai).toMatchObject({
      chatModel: "gpt-4.1-mini",
      embeddingsModel: "text-embedding-3-small",
      transcribeModel: "whisper-1",
    });
    expect(config.ingestion).toMatchObject({ maxUploadBytes: 10 * 1024 * 1024, chunkSize: 1000, chunkOverlap: 150 });
    expect(config.retrieval).toEqual({
      topK: 5,
      minScore: 0.2,
      semanticLimit: 20,
      lexicalLimit: 20,
      rrfK: 60,
      contextMaxChars: 6000,
    });
    expect(config.limits).toEqual({
      maxDocumentsPerUser: 100,
      maxStorageBytesPerUser: 200 * 1024 * 1024,
      maxChunksPerDocument: 2000,
    });
    expect(config.rateLimit).toEqual({ requests: 10, windowMs: 60_000 });
    expect(config.logQuestions).toBe(false);
    expect(config.ragDebug).toBe(false);
  });

  it("coerces numeric and boolean variables", () => {
    const config = loadConfig({ ...required, MAX_UPLOAD_BYTES: "2048", RETRIEVAL_TOP_K: "8", LOG_QUESTIONS: "true" });

    expect(config.ingestion.maxUploadBytes).toBe(2048);
    expect(config.retrieval.topK).toBe(8);
    expect(config.logQuestions).toBe(true);
  });

  it("reads the retrieval, limit, rate-limit and debug settings", () => {
    const config = loadConfig({
      ...required,
      RETRIEVAL_SEMANTIC_LIMIT: "30",
      RETRIEVAL_LEXICAL_LIMIT: "15",
      RETRIEVAL_CONTEXT_MAX_CHARS: "4000",
      MAX_DOCUMENTS_PER_USER: "7",
      MAX_STORAGE_BYTES_PER_USER: "1000000",
      MAX_CHUNKS_PER_DOCUMENT: "50",
      RATE_LIMIT_REQUESTS: "3",
      RATE_LIMIT_WINDOW_MS: "1000",
      RAG_DEBUG: "true",
    });

    expect(config.retrieval).toMatchObject({ semanticLimit: 30, lexicalLimit: 15, contextMaxChars: 4000 });
    expect(config.limits).toEqual({ maxDocumentsPerUser: 7, maxStorageBytesPerUser: 1_000_000, maxChunksPerDocument: 50 });
    expect(config.rateLimit).toEqual({ requests: 3, windowMs: 1000 });
    expect(config.ragDebug).toBe(true);
  });

  it("fails with a readable message for missing or inconsistent values", () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => loadConfig({ ...required, CHUNK_SIZE: "100", CHUNK_OVERLAP: "100" })).toThrow(/CHUNK_OVERLAP/);
    expect(() => loadConfig({ ...required, MAX_UPLOAD_BYTES: "-5" })).toThrow(/MAX_UPLOAD_BYTES/);
    expect(() => loadConfig({ ...required, RATE_LIMIT_REQUESTS: "0" })).toThrow(/RATE_LIMIT_REQUESTS/);
    expect(() => loadConfig({ ...required, RAG_DEBUG: "yes" })).toThrow(/RAG_DEBUG/);
    expect(() => loadConfig({ ...required, RETRIEVAL_CONTEXT_MAX_CHARS: "abc" })).toThrow(/RETRIEVAL_CONTEXT_MAX_CHARS/);
  });
});

describe("scrubSecrets", () => {
  it("removes Telegram tokens (also inside URLs), API keys and bearer tokens", () => {
    const text =
      "GET https://api.telegram.org/file/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/doc.pdf failed " +
      "with key sk-proj-abcdefghijklmnop1234 and Authorization: Bearer abcdef123456";

    const scrubbed = scrubSecrets(text);

    expect(scrubbed).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(scrubbed).not.toContain("sk-proj-abcdefghijklmnop1234");
    expect(scrubbed).not.toContain("abcdef123456");
    expect(scrubbed).toContain("doc.pdf");
  });
});

describe("normalizeText", () => {
  it("keeps paragraph structure while cleaning whitespace and NUL bytes", () => {
    expect(normalizeText("﻿a \t b\u0000\r\n\r\n\r\n\r\nc  \n d")).toBe("a b\n\nc\nd");
  });
});

describe("config sections", () => {
  it("loadToolConfig needs neither the Telegram token nor an OpenAI key", () => {
    const config = loadToolConfig({});

    expect(config.openai.embeddingsModel).toBe("text-embedding-3-small");
    expect(config.chunking).toEqual({ chunkSize: 1000, chunkOverlap: 150 });
    expect(config.retrieval.rrfK).toBe(60);
    expect(config).not.toHaveProperty("telegram");
    expect(JSON.stringify(config)).not.toContain("botToken");
  });

  it("loadToolConfig still validates the sections it uses", () => {
    expect(() => loadToolConfig({ CHUNK_SIZE: "100", CHUNK_OVERLAP: "100" })).toThrow(/CHUNK_OVERLAP/);
    expect(() => loadToolConfig({ RETRIEVAL_TOP_K: "0", RETRIEVAL_RRF_K: "x" })).toThrow(/RETRIEVAL_TOP_K[\s\S]*RETRIEVAL_RRF_K/);
  });

  it("the Telegram section alone demands the bot token", () => {
    expect(() => telegramConfig.load({})).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(telegramConfig.load({ TELEGRAM_BOT_TOKEN: "123:abc" }).telegram.botToken).toBe("123:abc");
    expect(() => openAiConfig.load({})).toThrow(/OPENAI_API_KEY/);
  });

  it("loadConfig reports every problem of every section at once", () => {
    expect(() => loadConfig({ RETRIEVAL_TOP_K: "0" })).toThrow(/TELEGRAM_BOT_TOKEN[\s\S]*OPENAI_API_KEY[\s\S]*RETRIEVAL_TOP_K|RETRIEVAL_TOP_K[\s\S]*TELEGRAM_BOT_TOKEN/);
  });
});
