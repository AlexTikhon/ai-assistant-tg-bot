import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";
import { OpenAIChatModel } from "../../src/infrastructure/openai/openai-chat-model.js";
import { createOpenAIEmbeddings, OpenAIEmbeddingsProvider } from "../../src/infrastructure/openai/openai-embeddings.js";
import { OpenAISpeechToText } from "../../src/infrastructure/openai/openai-speech-to-text.js";
import { readTextContent } from "../../src/infrastructure/openai/response-text.js";
import { ExternalServiceError } from "../../src/shared/errors.js";

const audio = { data: Buffer.from("audio-bytes"), fileName: "voice.ogg", mimeType: "audio/ogg" };

function createStt(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return new OpenAISpeechToText({ apiKey: "sk-test-key-123456789012345", model: "whisper-test", timeoutMs, fetchImpl });
}

describe("OpenAISpeechToText", () => {
  it("posts the audio with model and auth header and returns trimmed text only", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ text: "  hello world \n", usage: { seconds: 2 } }));

    const text = await createStt(fetchImpl as unknown as typeof fetch).transcribe(audio);

    expect(text).toBe("hello world");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key-123456789012345");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("whisper-test");
    expect((form.get("file") as File).name).toBe("voice.ogg");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("normalizes unsuccessful responses into ExternalServiceError without leaking the provider body", async () => {
    const fetchImpl = async () => new Response('{"error":{"message":"Incorrect API key sk-secret"}}', { status: 401 });

    const error = await createStt(fetchImpl as typeof fetch).transcribe(audio).catch((e) => e);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.message).not.toContain("sk-secret");
    expect((error.cause as Error).message).toContain("401");
  });

  it("normalizes network failures", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(createStt(fetchImpl as typeof fetch).transcribe(audio)).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("aborts requests that exceed the timeout", async () => {
    const fetchImpl = (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });

    const error = await createStt(fetchImpl as typeof fetch, 20).transcribe(audio).catch((e) => e);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect((error.cause as Error).name).toBe("TimeoutError");
  });

  it("rejects responses without a text field", async () => {
    const fetchImpl = async () => Response.json({ unexpected: true });

    await expect(createStt(fetchImpl as typeof fetch).transcribe(audio)).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("rejects invalid JSON", async () => {
    const fetchImpl = async () => new Response("<html>", { status: 200 });

    await expect(createStt(fetchImpl as typeof fetch).transcribe(audio)).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("OpenAIChatModel", () => {
  it("maps application roles to LangChain system/human messages and returns plain text", async () => {
    const invoke = vi.fn(async (_messages: BaseMessage[]) => ({ content: [{ type: "text", text: "Hello " }, { text: "there" }] }));

    const text = await new OpenAIChatModel({ invoke }).complete([
      { role: "system", content: "rules" },
      { role: "user", content: "question" },
    ]);

    expect(text).toBe("Hello there");
    const sent = invoke.mock.calls[0][0];
    expect(sent[0]).toBeInstanceOf(SystemMessage);
    expect(sent[1]).toBeInstanceOf(HumanMessage);
    expect(sent.map((message) => message.content)).toEqual(["rules", "question"]);
  });

  it("wraps provider errors", async () => {
    const model = new OpenAIChatModel({
      invoke: async () => {
        throw new Error("429 rate limited");
      },
    });

    const error = await model.complete([{ role: "user", content: "x" }]).catch((e) => e);

    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.message).not.toContain("429");
  });

  it("treats an empty completion as a failure", async () => {
    const model = new OpenAIChatModel({ invoke: async () => ({ content: "   " }) });

    await expect(model.complete([{ role: "user", content: "x" }])).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("OpenAIEmbeddingsProvider", () => {
  it("forwards cancellation to the SDK request and never starts the next paid batch", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal;
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      started();
    }));
    const provider = createOpenAIEmbeddings({ apiKey: "test", model: "test", timeoutMs: 1000, fetchImpl: fetchImpl as typeof fetch });
    const reason = new Error("cancelled");
    const result = provider.embedDocuments(Array.from({ length: provider.batchSize! + 1 }, () => "cat"), { signal: controller.signal });
    const rejected = expect(result).rejects.toBe(reason);
    await ready;
    controller.abort(reason);
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("restores input order from SDK response indices and refuses incomplete responses", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }));
    const provider = createOpenAIEmbeddings({ apiKey: "test", model: "test", timeoutMs: 1000, fetchImpl: fetchImpl as typeof fetch });
    expect(await provider.embedDocuments(["cat", "dog"])).toEqual([[1, 0], [0, 1]]);
    fetchImpl.mockImplementationOnce(async () => Response.json({ data: [{ index: 0, embedding: [1, 0] }] }));
    await expect(provider.embedDocuments(["cat", "dog"])).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("exposes its model, skips empty batches and wraps provider errors", async () => {
    const client = {
      embedDocuments: vi.fn(async () => [[1, 2]]),
      embedQuery: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const provider = new OpenAIEmbeddingsProvider("text-embedding-test", client);

    expect(provider.model).toBe("text-embedding-test");
    expect(await provider.embedDocuments([])).toEqual([]);
    expect(client.embedDocuments).not.toHaveBeenCalled();
    expect(await provider.embedDocuments(["a"])).toEqual([[1, 2]]);
    await expect(provider.embedQuery("q")).rejects.toBeInstanceOf(ExternalServiceError);
  });
});

describe("readTextContent", () => {
  it("handles strings, content parts and unknown shapes", () => {
    expect(readTextContent("  text ")).toBe("text");
    expect(readTextContent(["a", { text: "b" }, { type: "image" }])).toBe("ab");
    expect(readTextContent(undefined)).toBe("");
  });
});
