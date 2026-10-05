import { selectContext } from "../core/context-selection.js";
import type { ContextSelection, SkipReason } from "../core/context-selection.js";
import { boostExactMatches, DEFAULT_RRF_K, reciprocalRankFusion } from "../core/rank-fusion.js";
import type { FusedMatch } from "../core/rank-fusion.js";
import type { ChunkMatch, RetrievedChunk } from "../core/retrieval.js";
import {
  assessRetrievalConfidence,
  computeRetrievalSignals,
  DEFAULT_CONFIDENCE_POLICY,
  PASS_THROUGH_POLICY,
} from "../core/retrieval-confidence.js";
import type { ConfidenceAssessment, ConfidenceMode, ConfidencePolicy, RetrievalSignals } from "../core/retrieval-confidence.js";
import { analyzeQuery } from "../core/technical-tokens.js";
import type { EmbeddingsProvider } from "./ports/embeddings-provider.js";
import type { VectorStore } from "./ports/vector-store.js";
import { ensureQueryEmbedding } from "./validate-embeddings.js";
import { operationSignal, operationStep } from "../shared/operation.js";

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
  /** Weight of each ranking in the fusion; 1 / 1 (default) is plain RRF. */
  semanticWeight?: number;
  lexicalWeight?: number;
  /**
   * Extra evidence for a chunk that contains an identifier, file name, version or quoted phrase of the
   * question verbatim, as a multiple of the best single-ranking contribution 1 / (k + 1). 0 (default) = off.
   */
  exactTokenBonus?: number;
  /**
   * When the retrieved evidence is too weak, `retrieve` returns no context (the caller must not ask the model).
   * Absent: no gate - whatever was found is used.
   */
  confidence?: ConfidencePolicy;
  /**
   * What is done with the policy: "enforce" applies it, "shadow" only evaluates it (see RetrievalResult.shadow)
   * while retrieval behaves as if there were no gate, "off" ignores it. Default: "enforce" when a policy is
   * given, otherwise "off".
   */
  confidenceMode?: ConfidenceMode;
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

/** The ranked evidence for one question, before any decision about using it. */
export type RankedRetrieval = {
  /**
   * Every candidate that was ranked and loaded, in final order, *before* de-duplication, per-document caps
   * and the context budget. For diagnostics, evaluation and context selection.
   */
  candidates: RetrievedChunk[];
  signals: RetrievalSignals;
};

export type RetrievalResult = RankedRetrieval & {
  /** What retrieval actually did: in shadow mode this is the pass-through decision, never the hypothetical one. */
  confidence: ConfidenceAssessment;
  /** Shadow mode only: what the configured policy decided about the same evidence. It had no effect on `chunks`. */
  shadow?: { assessment: ConfidenceAssessment; policy: ConfidencePolicy };
  /** The context for the model, most relevant first. Empty whenever `confidence.decision` is "abstain". */
  chunks: RetrievedChunk[];
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

type Search = {
  question: string;
  semantic: ChunkMatch[];
  lexical: ChunkMatch[];
  fused: FusedMatch[];
};

type SearchTimings = Omit<RetrievalTrace["timings"], "contextMs" | "totalMs">;

/**
 * Hybrid retrieval: semantic (vector) and lexical (full-text) candidates are fused by reciprocal
 * rank fusion, the best of them are loaded, and a diversified, budget-limited context is selected.
 *
 * Vector search alone misses exact identifiers, file names and error strings; keyword search alone
 * misses paraphrases. Either path may come back empty (e.g. stale embeddings) without breaking the other.
 *
 * `rank` stops after ranking and describes the evidence (`signals`); `retrieve` additionally selects the
 * context. Both read only the asking user's chunks.
 */
export class HybridRetriever {
  private readonly now: () => number;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? (() => performance.now());
  }

  /** How the confidence gate is operated (see RetrievalOptions.confidenceMode). */
  get mode(): ConfidenceMode {
    return this.deps.options.confidenceMode ?? (this.deps.options.confidence ? "enforce" : "off");
  }

  /** Ranks candidates and describes the evidence; selects no context. */
  async rank(input: RetrieveInput): Promise<RankedRetrieval> {
    const [search] = await this.search(input);
    return this.loadRanked(input.userId, search);
  }

  async retrieve(input: RetrieveInput): Promise<RetrievalResult> {
    const startedAt = this.now();
    const [search, timings] = await this.search(input);

    const { confidence: policy } = this.deps.options;
    const mode = this.mode;

    const [{ ranked, confidence, selection, shadow }, contextMs] = await this.timed(async () => {
      const loaded = await this.loadRanked(input.userId, search);
      // Only "enforce" lets the policy decide. "shadow" evaluates it on the side and behaves like "off".
      const assessment = assessRetrievalConfidence(loaded.signals, mode === "enforce" ? (policy ?? PASS_THROUGH_POLICY) : PASS_THROUGH_POLICY);
      const shadowPolicy = policy ?? DEFAULT_CONFIDENCE_POLICY;
      const hypothetical: RetrievalResult["shadow"] =
        mode === "shadow" ? { assessment: assessRetrievalConfidence(loaded.signals, shadowPolicy), policy: shadowPolicy } : undefined;
      // Weak evidence never becomes context: the caller is told to abstain instead of hoping the model refuses.
      const chosen: ContextSelection = assessment.decision === "answer" ? this.select(loaded.candidates) : { selected: [], skipped: [] };
      return { ranked: loaded, confidence: assessment, selection: chosen, shadow: hypothetical };
    });

    return {
      ...ranked,
      confidence,
      ...(shadow ? { shadow } : {}),
      chunks: selection.selected,
      trace: {
        timings: { ...timings, contextMs, totalMs: roundMs(this.now() - startedAt) },
        counts: {
          semantic: search.semantic.length,
          lexical: search.lexical.length,
          fused: search.fused.length,
          loaded: ranked.candidates.length,
          selected: selection.selected.length,
        },
        contextChars: selection.selected.reduce((sum, chunk) => sum + chunk.content.length, 0),
        skipped: selection.skipped,
      },
    };
  }

  /** De-duplicates, caps per document and applies the character budget to ranked candidates. */
  select(candidates: readonly RetrievedChunk[]): ContextSelection {
    const { options } = this.deps;
    return selectContext(candidates, {
      maxChunks: options.topK,
      maxChars: options.contextMaxChars,
      maxPerDocument: Math.max(1, Math.ceil(options.topK / 2)),
    });
  }

  private async timed<T>(task: () => Promise<T> | T): Promise<[T, number]> {
    const stageStart = this.now();
    const value = await task();
    return [value, roundMs(this.now() - stageStart)];
  }

  /** Query embedding, both candidate rankings and their fusion. */
  private async search(input: RetrieveInput): Promise<[Search, SearchTimings]> {
    const { embeddings, vectorStore, options } = this.deps;

    const [queryEmbedding, embeddingMs] = await this.timed(async () => {
      const vector = await operationStep(() => embeddings.embedQuery(input.question, { signal: operationSignal() }));
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
      reciprocalRankFusion(semantic, lexical, options.rrfK ?? DEFAULT_RRF_K, {
        semantic: options.semanticWeight ?? 1,
        lexical: options.lexicalWeight ?? 1,
      }).slice(0, options.topK * CANDIDATE_POOL_FACTOR),
    );

    return [{ question: input.question, semantic, lexical, fused }, { embeddingMs, semanticMs, lexicalMs, fusionMs }];
  }

  /** Loads the text of the fused candidates (only now), applies the exact-token bonus and measures the evidence. */
  private async loadRanked(userId: string, search: Search): Promise<RankedRetrieval> {
    const { vectorStore, options } = this.deps;

    const stored = await vectorStore.getChunks(
      userId,
      search.fused.map((match) => match.chunkId),
    );
    const byId = new Map(stored.map((chunk) => [chunk.chunkId, chunk]));

    // Candidates deleted since they were ranked are simply gone.
    let candidates = search.fused.flatMap(({ chunkId, documentId, chunkIndex, ...ranking }): RetrievedChunk[] => {
      const chunk = byId.get(chunkId);
      return chunk ? [{ ...chunk, ranking }] : [];
    });

    const bonus = (options.exactTokenBonus ?? 0) / ((options.rrfK ?? DEFAULT_RRF_K) + 1);
    if (bonus > 0) {
      candidates = boostExactMatches(candidates, analyzeQuery(search.question).exactTargets, bonus);
    }

    return {
      candidates,
      signals: computeRetrievalSignals({ question: search.question, candidates }),
    };
  }
}
