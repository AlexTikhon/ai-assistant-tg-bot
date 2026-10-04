/** The most inputs the OpenAI embeddings endpoint accepts per request is far above this; 512 is what the client batches by default. */
export const MAX_EMBEDDING_BATCH_SIZE = 512;

/**
 * Budget for the summed tokens of one embeddings request. OpenAI rejects a request above its per-request cap
 * (300 000 tokens for the text-embedding-3 models), so this stays safely below it.
 */
export const EMBEDDING_REQUEST_TOKEN_BUDGET = 250_000;

/**
 * How many chunks to send in one embeddings request. The number of tokens in a chunk is not known here, so the
 * worst case is assumed - one token per character (token-dense text such as CJK comes close) - which makes the
 * request fit the budget whatever the language. For the default chunk size of 1000 characters that is 250 chunks,
 * i.e. a 2000-chunk document is embedded in 8 requests instead of 4: a few more calls, never a rejected one.
 */
export function embeddingBatchSize(chunkSizeChars: number): number {
  if (!(chunkSizeChars > 0)) {
    return MAX_EMBEDDING_BATCH_SIZE;
  }
  return Math.max(1, Math.min(MAX_EMBEDDING_BATCH_SIZE, Math.floor(EMBEDDING_REQUEST_TOKEN_BUDGET / chunkSizeChars)));
}

/** How many embeddings requests embedding `chunks` texts takes. Providers that do not batch count as one. */
export function countEmbeddingRequests(chunks: number, batchSize: number | undefined): number {
  if (chunks <= 0) return 0;
  return batchSize ? Math.ceil(chunks / batchSize) : 1;
}
