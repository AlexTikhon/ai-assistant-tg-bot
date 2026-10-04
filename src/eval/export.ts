import type { IndexProfile } from "../core/index-profile.js";
import type { ConfidencePolicy, ConfidenceReason, RetrievalSignals } from "../core/retrieval-confidence.js";
import type { AnswerabilityMetrics, SignalSummary } from "./answerability.js";
import type { DatasetDescription } from "./dataset.js";
import type { AggregateMetrics } from "./metrics.js";
import type { CaseResult, EvalReport, RetrievedItem, SplitMetrics, TagMetrics } from "./runner.js";

/** Bump when the shape of the exported JSON changes. */
export const EVAL_EXPORT_VERSION = 1;

/** Where a run came from: everything needed to tell whether two results are comparable. */
export type EvalRunInfo = {
  embeddings: { model: string; /** True when the model is the real, paid provider. */ live: boolean };
  dataset: DatasetDescription & { version: number; description?: string; file: string; documents: number };
  index: { fingerprint: string; profile: IndexProfile; chunks: number };
};

export type ExportedCase = {
  id: string;
  question: string;
  user: string;
  split: CaseResult["split"];
  answerable: boolean;
  tags: string[];
  decision: CaseResult["decision"];
  reason: ConfidenceReason;
  signals: RetrievalSignals;
  /** Which documents are expected - without the text fragments used to recognise the chunk. */
  expectedSources: Array<{ document: string }>;
  matchRanks: Array<number | null>;
  expectedSourceRank: number | null;
  reciprocalRank: number;
  recallAt: Record<number, number>;
  termCoverage?: number;
  /** The context the model would see (before the gate), as positions and ranks only. */
  retrieved: RetrievedItem[];
  isolationViolations: number;
};

export type EvalExport = {
  exportVersion: number;
  embeddings: EvalRunInfo["embeddings"];
  dataset: EvalRunInfo["dataset"];
  index: EvalRunInfo["index"];
  configuration: {
    chunking: { chunkSize: number; chunkOverlap: number };
    retrieval: Required<Omit<EvalReport["settings"], "confidence">>;
    confidencePolicy: ConfidencePolicy;
  };
  metrics: {
    ks: number[];
    overall: AggregateMetrics;
    termCoverage: number;
    noAnswer: EvalReport["noAnswer"];
    isolationViolations: number;
  };
  answerability: AnswerabilityMetrics;
  bySplit: Record<string, SplitMetrics>;
  byTag: Record<string, TagMetrics>;
  signals: { answerable: SignalSummary; unanswerable: SignalSummary };
  cases: ExportedCase[];
};

/**
 * The machine-readable result of one evaluation run (`npm run eval:retrieval -- --json`). Deterministic - no
 * timestamps, no paths of the machine - so two runs of the same code, dataset and corpus produce identical
 * files that can be diffed. Contains the questions of the dataset, but never document text or credentials.
 */
export function buildEvalExport(report: EvalReport, info: EvalRunInfo): EvalExport {
  const retrieval = report.settings;

  return {
    exportVersion: EVAL_EXPORT_VERSION,
    embeddings: info.embeddings,
    dataset: info.dataset,
    index: info.index,
    configuration: {
      chunking: { chunkSize: info.index.profile.chunkSize, chunkOverlap: info.index.profile.chunkOverlap },
      retrieval: {
        topK: retrieval.topK,
        minScore: retrieval.minScore,
        semanticLimit: retrieval.semanticLimit,
        lexicalLimit: retrieval.lexicalLimit,
        rrfK: retrieval.rrfK,
        contextMaxChars: retrieval.contextMaxChars,
        semanticWeight: retrieval.semanticWeight ?? 1,
        lexicalWeight: retrieval.lexicalWeight ?? 1,
        exactTokenBonus: retrieval.exactTokenBonus ?? 0,
      },
      confidencePolicy: report.policy,
    },
    metrics: {
      ks: report.ks,
      overall: report.overall,
      termCoverage: report.termCoverage,
      noAnswer: report.noAnswer,
      isolationViolations: report.isolationViolations,
    },
    answerability: report.answerability,
    bySplit: report.bySplit,
    byTag: report.byTag,
    signals: report.signals,
    cases: report.cases.map(exportCase),
  };
}

function exportCase(result: CaseResult): ExportedCase {
  return {
    id: result.id,
    question: result.question,
    user: result.user,
    split: result.split,
    answerable: result.answerable,
    tags: result.tags,
    decision: result.decision,
    reason: result.reason,
    signals: result.signals,
    expectedSources: result.expectedSources.map((source) => ({ document: source.document })),
    matchRanks: result.matchRanks,
    expectedSourceRank: result.expectedSourceRank,
    reciprocalRank: result.reciprocalRank,
    recallAt: result.recallAt,
    ...(result.termCoverage !== undefined ? { termCoverage: result.termCoverage } : {}),
    retrieved: result.retrieved,
    isolationViolations: result.isolationViolations,
  };
}
