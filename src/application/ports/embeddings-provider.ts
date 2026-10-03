export interface EmbeddingsProvider {
  /** Identifier of the model that produces the vectors; stored next to them. */
  readonly model: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
