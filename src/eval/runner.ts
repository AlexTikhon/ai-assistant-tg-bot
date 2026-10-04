import { HybridRetriever } from "../application/hybrid-retriever.js";
import type { RetrievalOptions } from "../application/hybrid-retriever.js";
import type { EmbeddingsProvider } from "../application/ports/embeddings-provider.js";
import type { RetrievedChunk } from "../core/retrieval.js";
import { findMatchRanks, matchesExpectedSource } from "./dataset.js";
import type { EvalCase, ExpectedSource, RetrievedForMatching } from "./dataset.js";
import type { EvalIndex } from "./harness.js";
import { aggregateCases, hitAtK, mean, recallAtK, reciprocalRank } from "./metrics.js";
import type { AggregateMetrics } from "./metrics.js";

/** The query-time settings under evaluation; the same knobs the bot has. */
export type RetrievalSettings = Required<RetrievalOptions>;

export const DEFAULT_KS = [1, 3, 5] as const;

export type RetrievedItem = {
  rank: number;
  document: string;
  owner: string;
  chunkIndex: number;
  semanticRank?: number;
  lexicalRank?: number;
  fusedRank: number;
  /** Whether it satisfies any expected source of the case. */
  relevant: boolean;
};

export type CaseResult = {
  id: string;
  question: string;
  user: string;
  tags: string[];
  expectedSources: ExpectedSource[];
  /** False for questions the corpus cannot answer (no expected sources). */
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
  byTag: Record<string, AggregateMetrics>;
  /** Mean share of expected terms present in the context (cases that list terms). */
  termCoverage: number;
  noAnswer: { cases: number; withContext: number };
  isolationViolations: number;
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

  const cases: CaseResult[] = [];
  for (const evalCase of input.cases) {
    cases.push(await evaluateCase(evalCase, retriever, input.index.owners, ks));
  }

  const tags = [...new Set(cases.flatMap((result) => result.tags))].sort();
  const noAnswer = cases.filter((result) => !result.answerable);

  return {
    settings: input.retrieval,
    ks,
    cases,
    overall: aggregate(cases, ks),
    byTag: Object.fromEntries(tags.map((tag) => [tag, aggregate(cases.filter((result) => result.tags.includes(tag)), ks)])),
    termCoverage: mean(cases.map((result) => result.termCoverage)),
    noAnswer: { cases: noAnswer.length, withContext: noAnswer.filter((result) => result.retrieved.length > 0).length },
    isolationViolations: cases.reduce((sum, result) => sum + result.isolationViolations, 0),
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
): Promise<CaseResult> {
  const { chunks, candidates } = await retriever.retrieve({ userId: evalCase.user, question: evalCase.question });

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
    expectedSources,
    answerable: expectedSources.length > 0,
    matchRanks,
    candidateMatchRanks,
    hit: hitAtK(matchRanks, Math.max(...ks)) === 1,
    reciprocalRank: reciprocalRank(matchRanks) ?? 0,
    recallAt: Object.fromEntries(ks.map((k) => [k, recallAtK(matchRanks, k) ?? 0])),
    retrieved,
    firstRelevant,
    termCoverage,
    isolationViolations: candidates.filter((chunk) => ownerOf(chunk) !== user).length,
    lostToSelection: candidateMatchRanks.some((rank, index) => rank !== null && matchRanks[index] === null),
  };
}
