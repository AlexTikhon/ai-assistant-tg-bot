import type { EmbeddingsProvider } from "../application/ports/embeddings-provider.js";

/**
 * Remembers every vector it has produced. Comparing configurations indexes the same chunks and asks the
 * same questions again and again; with a paid provider that would pay for identical texts repeatedly.
 */
export class CachingEmbeddings implements EmbeddingsProvider {
  private readonly cache = new Map<string, number[]>();
  /** Texts that actually reached the wrapped provider (for tests and cost reporting). */
  providerCalls = 0;

  constructor(private readonly inner: EmbeddingsProvider) {}

  get model() {
    return this.inner.model;
  }

  async embedDocuments(texts: string[]) {
    const missing = [...new Set(texts.filter((text) => !this.cache.has(text)))];
    if (missing.length > 0) {
      const vectors = await this.inner.embedDocuments(missing);
      this.providerCalls += missing.length;
      missing.forEach((text, index) => this.cache.set(text, vectors[index]));
    }
    return texts.map((text) => this.cache.get(text)!);
  }

  async embedQuery(text: string) {
    const cached = this.cache.get(`query:${text}`);
    if (cached) {
      return cached;
    }
    const vector = await this.inner.embedQuery(text);
    this.providerCalls += 1;
    this.cache.set(`query:${text}`, vector);
    return vector;
  }
}
