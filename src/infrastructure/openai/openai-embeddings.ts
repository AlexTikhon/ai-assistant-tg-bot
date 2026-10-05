import OpenAI from "openai";
import type { EmbeddingsProvider } from "../../application/ports/embeddings-provider.js";
import { embeddingBatchSize } from "../../core/embedding-batches.js";
import { ExternalServiceError } from "../../shared/errors.js";
import { operationStep } from "../../shared/operation.js";
import type { OperationOptions } from "../../shared/operation.js";

/** The embeddings client contract this adapter needs (also what tests fake). */
export type EmbeddingsClient = {
  embedDocuments(texts: string[], options?: OperationOptions): Promise<number[][]>;
  embedQuery(text: string, options?: OperationOptions): Promise<number[]>;
};

export class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  constructor(
    readonly model: string,
    private readonly client: EmbeddingsClient,
    /** How many texts the client sends per request (see embeddingBatchSize); for counting requests. */
    readonly batchSize?: number,
  ) {}

  async embedDocuments(texts: string[], options: OperationOptions = {}) {
    options.signal?.throwIfAborted();
    if (texts.length === 0) {
      return [];
    }

    try {
      return await operationStep(() => this.client.embedDocuments(texts, options), options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new ExternalServiceError("openai", { cause: error });
    }
  }

  async embedQuery(text: string, options: OperationOptions = {}) {
    try {
      return await operationStep(() => this.client.embedQuery(text, options), options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new ExternalServiceError("openai", { cause: error });
    }
  }
}

/**
 * Use the SDK's per-request signal directly: LangChain's embeddings methods do not accept one.
 * Batches are sequential and checked between requests, so cancellation cannot start another paid batch.
 * SDK retries remain bounded; publication still requires the complete, validated result.
 */
export function createOpenAIEmbeddings(options: { apiKey: string; model: string; timeoutMs: number; chunkSize?: number; fetchImpl?: typeof fetch }) {
  const batchSize = embeddingBatchSize(options.chunkSize ?? 1000);
  const sdk = new OpenAI({ apiKey: options.apiKey, timeout: options.timeoutMs, maxRetries: 2, ...(options.fetchImpl ? { fetch: options.fetchImpl } : {}) });
  const embed = async (input: string[], request: OperationOptions = {}) => {
    request.signal?.throwIfAborted();
    const response = await sdk.embeddings.create({ model: options.model, input: input.map((text) => text.replace(/\n/g, " ")), encoding_format: "float" }, request);
    if (response.data.length !== input.length || new Set(response.data.map((item) => item.index)).size !== input.length ||
        response.data.some((item) => item.index < 0 || item.index >= input.length)) {
      throw new Error("Embeddings response did not match the requested inputs");
    }
    return response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  };

  return new OpenAIEmbeddingsProvider(
    options.model,
    {
      async embedDocuments(texts, request) {
        const vectors: number[][] = [];
        for (let start = 0; start < texts.length; start += batchSize) {
          request?.signal?.throwIfAborted();
          vectors.push(...await embed(texts.slice(start, start + batchSize), request));
        }
        return vectors;
      },
      async embedQuery(text, request) { return (await embed([text], request))[0]; },
    },
    batchSize,
  );
}
