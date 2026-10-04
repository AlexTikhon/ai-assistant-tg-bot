import type { EmbeddingsProvider } from "../../application/ports/embeddings-provider.js";

/**
 * Stands in for the embeddings provider in commands that must not call OpenAI (`reindex --dry-run`):
 * it knows the configured model name - all a dry run compares - and refuses to embed anything, so a
 * dry run cannot cost money even by accident, and needs no API key.
 */
export class OfflineEmbeddings implements EmbeddingsProvider {
  constructor(readonly model: string) {}

  async embedDocuments(): Promise<number[][]> {
    throw new Error("Embeddings are not available in this mode (no OPENAI_API_KEY was provided).");
  }

  async embedQuery(): Promise<number[]> {
    throw new Error("Embeddings are not available in this mode (no OPENAI_API_KEY was provided).");
  }
}
