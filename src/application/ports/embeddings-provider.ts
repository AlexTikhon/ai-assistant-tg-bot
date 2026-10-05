import type { OperationOptions } from "../../shared/operation.js";

export interface EmbeddingsProvider {
  /** Identifier of the model that produces the vectors; stored next to them. */
  readonly model: string;
  /** Texts sent per request, when the provider batches. Used to count (and bound) requests; absent: not batched. */
  readonly batchSize?: number;
  embedDocuments(texts: string[], options?: OperationOptions): Promise<number[][]>;
  embedQuery(text: string, options?: OperationOptions): Promise<number[]>;
}
