export interface EmbeddingsProvider {
  /** Identifier of the model that produces the vectors; stored next to them. */
  readonly model: string;
  /** Texts sent per request, when the provider batches. Used to count (and bound) requests; absent: not batched. */
  readonly batchSize?: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
