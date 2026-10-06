import { HybridRetriever } from "../application/hybrid-retriever.js";
import type { RetrievalOptions } from "../application/hybrid-retriever.js";
import type { EmbeddingsProvider } from "../application/ports/embeddings-provider.js";
import type { RetrievedChunk } from "../core/retrieval.js";
import { assessRetrievalConfidence, DEFAULT_CONFIDENCE_POLICY } from "../core/retrieval-confidence.js";
import type { ConfidencePolicy, ConfidenceReason, RetrievalSignals } from "../core/retrieval-confidence.js";
import { answerabilityMetrics, confusionMatrix, summarizeSignals } from "./answerability.js";
import type { AnswerabilityMetrics, SignalSummary } from "./answerability.js";
import { DATASET_SPLITS, findMatchRanks, matchesExpectedSource } from "./dataset.js";
import type { DatasetSplit, EvalCase, ExpectedSource, RetrievedForMatching } from "./dataset.js";
import type { EvalIndex } from "./harness.js";
import { aggregateCases, hitAtK, mean, recallAtK, reciprocalRank } from "./metrics.js";
import type { AggregateMetrics } from "./metrics.js";

/** The query-time settings under evaluation; the same knobs the bot has. rrfK is always explicit so a report states it. */
/** Evaluation measures the gate itself, so the operational rollout mode (off/shadow/enforce) is not a setting here. */
export type RetrievalSettings = Omit<RetrievalOptions, "rrfK" | "confidenceMode"> & { rrfK: number };

const DEFAULT_KS = [1, 3, 5] as const;

export type RetrievedItem = {
  rank: number;
  document: string;
  owner: string;
  chunkIndex: number;
  semanticRank?: number;
  lexicalRank?: number;
  fusedRank: number;
  /** Number of the question's exact targets the chunk contains; present when the exact-token bonus was applied to it. */
  exactMatches?: number;
  /** Whether it satisfies any expected source of the case. */
  relevant: boolean;
};

export type CaseResult = {
  id: string;
  question: string;
  user: string;
  tags: string[];
  split: DatasetSplit;
  expectedSources: ExpectedSource[];
  /** False for questions the corpus cannot answer, as declared by the dataset. */
  answerable: boolean;
  /** Per expected source: rank of the first matching chunk in the context, or null. */
  matchRanks: Array<number | null>;
  /** The same within the ranked candidates before context selection. */
  candidateMatchRanks: Array<number | null>;
  hit: boolean;
  reciprocalRank: number;
  /** Recall within the first K context chunks, for each evaluated K. */
  recallAt: Record<number, number>;
  /** The context the model would see, best first. */
  retrieved: RetrievedItem[];
  /** How the first relevant chunk ranked in each method (from the context, else from the candidates). */
  firstRelevant: (RetrievedItem & { inContext: boolean }) | null;
  /** Share of `expectedTerms` found in the context text; undefined when the case lists none. */
  termCoverage?: number;
  /** Rank of the best expected source among the ranked candidates (1 = first), null when none or nothing was expected. */
  expectedSourceRank: number | null;
  /** The evidence the retriever measured for this question. */
  signals: RetrievalSignals;
  /** What the confidence gate would do with this question under the evaluated policy. */
  decision: "answer" | "abstain";
  reason: ConfidenceReason;
  /** Ranked candidates that belong to another user than the asker. Must always be 0. */
  isolationViolations: number;
  /** An expected source was a candidate but context selection kept it out. */
  lostToSelection: boolean;
};

export type EvalReport = {
  settings: RetrievalSettings;
  ks: number[];
  cases: CaseResult[];
  overall: AggregateMetrics;
  byTag: Record<string, TagMetrics>;
  /** Mean share of expected terms present in the context (cases that list terms). */
  termCoverage: number;
  /** Unanswerable questions, and how many of them still got context from plain retrieval (before the gate). */
  noAnswer: { cases: number; withContext: number };
  isolationViolations: number;
  /** The confidence policy the decisions below were made with. */
  policy: ConfidencePolicy;
  /** What the gate does to answerable and unanswerable questions. */
  answerability: AnswerabilityMetrics;
  /** Retrieval and gate results per dataset split: calibration is for choosing, validation only for reporting. */
  bySplit: Record<DatasetSplit, SplitMetrics>;
  /** Distribution of the retrieval evidence for answerable vs unanswerable questions. */
  signals: { answerable: SignalSummary; unanswerable: SignalSummary };
};

export type TagMetrics = AggregateMetrics & {
  /** All questions with the tag, answerable or not (`cases` counts the answerable ones). */
  queries: number;
  answerability: AnswerabilityMetrics;
};

export type SplitMetrics = {
  queries: number;
  retrieval: AggregateMetrics;
  answerability: AnswerabilityMetrics;
};

export type RunEvaluationInput = {
  cases: readonly EvalCase[];
  index: Pick<EvalIndex, "vectorStore" | "owners">;
  embeddings: EmbeddingsProvider;
  retrieval: RetrievalSettings;
  ks?: readonly number[];
};

/**
 * Asks every question through the production HybridRetriever (query embedding, semantic scan, FTS5,
 * RRF, loading, de-duplication/caps/budget) and scores what the model would have been given against
 * the ground truth of the dataset. Nothing here calls a chat model.
 */
export async function runEvaluation(input: RunEvaluationInput): Promise<EvalReport> {
  const ks = [...(input.ks ?? DEFAULT_KS)];
  const retriever = new HybridRetriever({
    embeddings: input.embeddings,
    vectorStore: input.index.vectorStore,
    options: input.retrieval,
  });

  const policy = input.retrieval.confidence ?? DEFAULT_CONFIDENCE_POLICY;
  const cases: CaseResult[] = [];
  for (const evalCase of input.cases) {
    cases.push(await evaluateCase(evalCase, retriever, input.index.owners, ks, policy));
  }

  const tags = [...new Set(cases.flatMap((result) => result.tags))].sort();
  const noAnswer = cases.filter((result) => !result.answerable);
  const gate = (items: readonly CaseResult[]) => answerabilityMetrics(confusionMatrix(items));

  return {
    settings: input.retrieval,
    ks,
    cases,
    overall: aggregate(cases, ks),
    byTag: Object.fromEntries(
      tags.map((tag) => {
        const tagged = cases.filter((result) => result.tags.includes(tag));
        return [tag, { ...aggregate(tagged, ks), queries: tagged.length, answerability: gate(tagged) }];
      }),
    ),
    termCoverage: mean(cases.map((result) => result.termCoverage)),
    noAnswer: { cases: noAnswer.length, withContext: noAnswer.filter((result) => result.retrieved.length > 0).length },
    isolationViolations: cases.reduce((sum, result) => sum + result.isolationViolations, 0),
    policy,
    answerability: gate(cases),
    bySplit: Object.fromEntries(
      DATASET_SPLITS.map((split) => {
        const inSplit = cases.filter((result) => result.split === split);
        return [split, { queries: inSplit.length, retrieval: aggregate(inSplit, ks), answerability: gate(inSplit) }];
      }),
    ) as Record<DatasetSplit, SplitMetrics>,
    signals: {
      answerable: summarizeSignals(cases.filter((result) => result.answerable).map((result) => result.signals)),
      unanswerable: summarizeSignals(noAnswer.map((result) => result.signals)),
    },
  };
}

function aggregate(cases: readonly CaseResult[], ks: readonly number[]) {
  return aggregateCases(
    cases.map((result) => ({ ranks: result.matchRanks, candidateRanks: result.candidateMatchRanks })),
    ks,
  );
}

async function evaluateCase(
  evalCase: EvalCase,
  retriever: HybridRetriever,
  owners: ReadonlyMap<string, string>,
  ks: readonly number[],
  policy: ConfidencePolicy,
): Promise<CaseResult> {
  const { candidates, signals } = await retriever.rank({ userId: evalCase.user, question: evalCase.question });
  const chunks = retriever.select(candidates).selected;
  // The same pure function the bot applies in HybridRetriever.retrieve().
  const { decision, reason } = assessRetrievalConfidence(signals, policy);

  const ownerOf = (chunk: RetrievedChunk) => owners.get(chunk.documentId) ?? "(unknown)";
  const forMatching = (list: RetrievedChunk[]): RetrievedForMatching[] =>
    list.map((chunk) => ({ owner: ownerOf(chunk), fileName: chunk.fileName, chunkIndex: chunk.chunkIndex, content: chunk.content }));

  const { expectedSources, user } = evalCase;
  const matchRanks = findMatchRanks(forMatching(chunks), expectedSources, user);
  const candidateMatchRanks = findMatchRanks(forMatching(candidates), expectedSources, user);
  const isRelevant = (chunk: RetrievedChunk) =>
    expectedSources.some((expected) => matchesExpectedSource(forMatching([chunk])[0], expected, user));

  const toItem = (chunk: RetrievedChunk, rank: number): RetrievedItem => ({
    rank,
    document: chunk.fileName,
    owner: ownerOf(chunk),
    chunkIndex: chunk.chunkIndex,
    semanticRank: chunk.ranking.semanticRank,
    lexicalRank: chunk.ranking.lexicalRank,
    fusedRank: chunk.ranking.fusedRank,
    ...(chunk.ranking.exactMatches !== undefined ? { exactMatches: chunk.ranking.exactMatches } : {}),
    relevant: isRelevant(chunk),
  });
  const retrieved = chunks.map((chunk, index) => toItem(chunk, index + 1));

  const inContext = retrieved.find((item) => item.relevant);
  const candidateIndex = candidates.findIndex(isRelevant);
  const firstRelevant = inContext
    ? { ...inContext, inContext: true }
    : candidateIndex >= 0
      ? { ...toItem(candidates[candidateIndex], candidateIndex + 1), inContext: false }
      : null;

  const contextText = chunks.map((chunk) => chunk.content.toLowerCase()).join("\n");
  const termCoverage =
    evalCase.expectedTerms.length === 0
      ? undefined
      : evalCase.expectedTerms.filter((term) => contextText.includes(term.toLowerCase())).length / evalCase.expectedTerms.length;

  return {
    id: evalCase.id,
    question: evalCase.question,
    user,
    tags: evalCase.tags,
    split: evalCase.split,
    expectedSources,
    answerable: evalCase.answerable,
    matchRanks,
    candidateMatchRanks,
    hit: hitAtK(matchRanks, Math.max(...ks)) === 1,
    reciprocalRank: reciprocalRank(matchRanks) ?? 0,
    recallAt: Object.fromEntries(ks.map((k) => [k, recallAtK(matchRanks, k) ?? 0])),
    retrieved,
    firstRelevant,
    termCoverage,
    isolationViolations: candidates.filter((chunk) => ownerOf(chunk) !== user).length,
    expectedSourceRank: candidateMatchRanks.reduce<number | null>((best, rank) => (rank !== null && (best === null || rank < best) ? rank : best), null),
    signals,
    decision,
    reason,
    lostToSelection: candidateMatchRanks.some((rank, index) => rank !== null && matchRanks[index] === null),
  };
}
