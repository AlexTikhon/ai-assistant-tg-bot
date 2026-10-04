import { OpenAIEmbeddings } from "@langchain/openai";
import type { EmbeddingsProvider } from "../../application/ports/embeddings-provider.js";
import { embeddingBatchSize } from "../../core/embedding-batches.js";
import { ExternalServiceError } from "../../shared/errors.js";

/** The slice of a LangChain embeddings client this adapter needs (also what tests fake). */
export type EmbeddingsClient = {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
};

export class OpenAIEmbeddingsProvider implements EmbeddingsProvider {
  constructor(
    readonly model: string,
    private readonly client: EmbeddingsClient,
    /** How many texts the client sends per request (see embeddingBatchSize); for counting requests. */
    readonly batchSize?: number,
  ) {}

  async embedDocuments(texts: string[]) {
    if (texts.length === 0) {
      return [];
    }

    try {
      return await this.client.embedDocuments(texts);
    } catch (error) {
      throw new ExternalServiceError("openai", { cause: error });
    }
  }

  async embedQuery(text: string) {
    try {
      return await this.client.embedQuery(text);
    } catch (error) {
      throw new ExternalServiceError("openai", { cause: error });
    }
  }
}

/**
 * The LangChain client already batches (in order, all-or-nothing: one failed batch fails the whole call, so a
 * partial index can never be produced) and the SDK underneath retries transient failures (429, 5xx, connection
 * errors, honouring Retry-After) `maxRetries` times - which is why embeddings are not wrapped in another retry.
 * The batch size is set explicitly, from the configured chunk size, so one request cannot exceed the provider's
 * token cap even for token-dense text.
 */
export function createOpenAIEmbeddings(options: { apiKey: string; model: string; timeoutMs: number; chunkSize?: number }) {
  const batchSize = embeddingBatchSize(options.chunkSize ?? 1000);

  return new OpenAIEmbeddingsProvider(
    options.model,
    new OpenAIEmbeddings({
      model: options.model,
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: 2,
      batchSize,
    }),
    batchSize,
  );
}
