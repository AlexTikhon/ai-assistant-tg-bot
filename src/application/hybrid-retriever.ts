import { selectContext } from "../core/context-selection.js";
import type { SkipReason } from "../core/context-selection.js";
import { DEFAULT_RRF_K, reciprocalRankFusion } from "../core/rank-fusion.js";
import type { RetrievedChunk } from "../core/retrieval.js";
import type { EmbeddingsProvider } from "./ports/embeddings-provider.js";
import type { VectorStore } from "./ports/vector-store.js";
import { ensureQueryEmbedding } from "./validate-embeddings.js";

export type RetrievalOptions = {
  /** Maximum number of chunks handed to the model. */
  topK: number;
  /** Minimum cosine similarity for a chunk to count as a semantic candidate. */
  minScore: number;
  /** Depth of the semantic and the lexical candidate lists that are fused. */
  semanticLimit: number;
  lexicalLimit: number;
  /** Reciprocal rank fusion constant; larger flattens the advantage of top ranks. Default 60. */
  rrfK?: number;
  /** Approximate budget for the summed length of the selected chunk texts. */
  contextMaxChars: number;
};

export type RetrieveInput = {
  userId: string;
  question: string;
  documentId?: string;
};

/** Everything worth knowing about how a retrieval went. Contains ids and numbers only - never text. */
export type RetrievalTrace = {
  timings: {
    embeddingMs: number;
    semanticMs: number;
    lexicalMs: number;
    fusionMs: number;
    contextMs: number;
    totalMs: number;
  };
  counts: { semantic: number; lexical: number; fused: number; loaded: number; selected: number };
  contextChars: number;
  skipped: Array<{ chunkId: string; reason: SkipReason }>;
};

export type RetrievalResult = {
  /** The context for the model, most relevant first. */
  chunks: RetrievedChunk[];
  /**
   * Every candidate that was ranked and loaded, in fused order, *before* de-duplication, per-document caps
   * and the context budget. `chunks` is a subset. For diagnostics and evaluation (did selection drop evidence?).
   */
  candidates: RetrievedChunk[];
  trace: RetrievalTrace;
};

type Dependencies = {
  embeddings: EmbeddingsProvider;
  vectorStore: VectorStore;
  options: RetrievalOptions;
  /** Monotonic clock in milliseconds; injectable for deterministic timing tests. */
  now?: () => number;
};

/** Candidates loaded for diversification, as a multiple of the final context size. */
const CANDIDATE_POOL_FACTOR = 3;

const roundMs = (ms: number) => Math.round(ms * 10) / 10;

/**
 * Hybrid retrieval: semantic (vector) and lexical (full-text) candidates are fused by reciprocal
 * rank fusion, the best of them are loaded, and a diversified, budget-limited context is selected.
 *
 * Vector search alone misses exact identifiers, file names and error strings; keyword search alone
 * misses paraphrases. Either path may come back empty (e.g. stale embeddings) without breaking the other.
 */
export class HybridRetriever {
  private readonly now: () => number;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? (() => performance.now());
  }

  async retrieve(input: RetrieveInput): Promise<RetrievalResult> {
    const { embeddings, vectorStore, options } = this.deps;
    const startedAt = this.now();
    const [queryEmbedding, embeddingMs] = await this.timed(async () => {
      const vector = await embeddings.embedQuery(input.question);
      ensureQueryEmbedding(vector);
      return vector;
    });

    const [semantic, semanticMs] = await this.timed(() =>
      vectorStore.searchSimilar({
        userId: input.userId,
        documentId: input.documentId,
        embedding: queryEmbedding,
        embeddingModel: embeddings.model,
        limit: options.semanticLimit,
        minScore: options.minScore,
      }),
    );
    const [lexical, lexicalMs] = await this.timed(() =>
      vectorStore.searchLexical({
        userId: input.userId,
        documentId: input.documentId,
        query: input.question,
        limit: options.lexicalLimit,
      }),
    );

    const [fused, fusionMs] = await this.timed(() =>
      reciprocalRankFusion(semantic, lexical, options.rrfK ?? DEFAULT_RRF_K).slice(0, options.topK * CANDIDATE_POOL_FACTOR),
    );

    const [{ selection, candidates }, contextMs] = await this.timed(() => this.selectFinalContext(input.userId, fused));

    return {
      chunks: selection.selected,
      candidates,
      trace: {
        timings: {
          embeddingMs,
          semanticMs,
          lexicalMs,
          fusionMs,
          contextMs,
          totalMs: roundMs(this.now() - startedAt),
        },
        counts: {
          semantic: semantic.length,
          lexical: lexical.length,
          fused: fused.length,
          loaded: candidates.length,
          selected: selection.selected.length,
        },
        contextChars: selection.selected.reduce((sum, chunk) => sum + chunk.content.length, 0),
        skipped: selection.skipped,
      },
    };
  }

  private async timed<T>(task: () => Promise<T> | T): Promise<[T, number]> {
    const stageStart = this.now();
    const value = await task();
    return [value, roundMs(this.now() - stageStart)];
  }

  /** Loads the text of the fused candidates (only now) and selects the final context. */
  private async selectFinalContext(userId: string, fused: ReturnType<typeof reciprocalRankFusion>) {
    const { vectorStore, options } = this.deps;

    const stored = await vectorStore.getChunks(
      userId,
      fused.map((match) => match.chunkId),
    );
    const byId = new Map(stored.map((chunk) => [chunk.chunkId, chunk]));

    // Candidates deleted since they were ranked are simply gone.
    const candidates = fused.flatMap(({ chunkId, documentId, chunkIndex, ...ranking }): RetrievedChunk[] => {
      const chunk = byId.get(chunkId);
      return chunk ? [{ ...chunk, ranking }] : [];
    });

    const selection = selectContext(candidates, {
      maxChunks: options.topK,
      maxChars: options.contextMaxChars,
      maxPerDocument: Math.max(1, Math.ceil(options.topK / 2)),
    });
    return { selection, candidates };
  }
}
