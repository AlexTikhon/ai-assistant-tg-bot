import { OpenAIEmbeddings } from "@langchain/openai";
import type { EmbeddingsProvider } from "../../application/ports/embeddings-provider.js";
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

export function createOpenAIEmbeddings(options: { apiKey: string; model: string; timeoutMs: number }) {
  return new OpenAIEmbeddingsProvider(
    options.model,
    new OpenAIEmbeddings({
      model: options.model,
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: 2,
    }),
  );
}
