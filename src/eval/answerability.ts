import type { RetrievalSignals } from "../core/retrieval-confidence.js";

/**
 * "Positive" means the gate lets a question through to the model. An answerable question that is let
 * through is a true positive; an unanswerable one that is let through is a false positive (weak context
 * sent to the model); an answerable one that is rejected is a false negative (a wrongly refused user).
 */
export type ConfusionMatrix = { tp: number; fn: number; fp: number; tn: number };

export type AnswerabilityMetrics = ConfusionMatrix & {
  /** Of the questions let through, the share that were answerable. null when nothing was let through. */
  precision: number | null;
  /** Of the answerable questions, the share that were let through. */
  recall: number | null;
  /** Of the unanswerable questions, the share that were rejected. */
  specificity: number | null;
  falsePositiveRate: number | null;
  falseNegativeRate: number | null;
};

export type GateOutcome = { answerable: boolean; decision: "answer" | "abstain" };

export function confusionMatrix(outcomes: readonly GateOutcome[]): ConfusionMatrix {
  const matrix: ConfusionMatrix = { tp: 0, fn: 0, fp: 0, tn: 0 };
  for (const { answerable, decision } of outcomes) {
    if (answerable) {
      matrix[decision === "answer" ? "tp" : "fn"] += 1;
    } else {
      matrix[decision === "answer" ? "fp" : "tn"] += 1;
    }
  }
  return matrix;
}

/** A ratio, or null (never NaN) when the denominator is zero, so reports stay valid JSON. */
const ratio = (numerator: number, denominator: number) => (denominator === 0 ? null : numerator / denominator);

export function answerabilityMetrics(matrix: ConfusionMatrix): AnswerabilityMetrics {
  const { tp, fn, fp, tn } = matrix;
  return {
    ...matrix,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
    specificity: ratio(tn, tn + fp),
    falsePositiveRate: ratio(fp, fp + tn),
    falseNegativeRate: ratio(fn, fn + tp),
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Simple distribution summary of the evidence for one group of questions (answerable or not). */
export type SignalSummary = {
  cases: number;
  medianTopSemanticScore: number | null;
  medianTopFusedScore: number | null;
  medianTermCoverage: number | null;
  /** Shares of the group (0..1); null for an empty group. */
  withSemanticHit: number | null;
  withLexicalHit: number | null;
  withDualMethodHit: number | null;
  withExactTokenHit: number | null;
};

export function summarizeSignals(group: readonly RetrievalSignals[]): SignalSummary {
  const share = (predicate: (signals: RetrievalSignals) => boolean) =>
    group.length === 0 ? null : group.filter(predicate).length / group.length;
  const defined = (pick: (signals: RetrievalSignals) => number | null) =>
    group.map(pick).filter((value): value is number => value !== null);

  return {
    cases: group.length,
    medianTopSemanticScore: median(defined((signals) => signals.topSemanticScore)),
    medianTopFusedScore: median(defined((signals) => signals.topFusedScore)),
    medianTermCoverage: median(group.map((signals) => signals.bestTermCoverage)),
    withSemanticHit: share((signals) => signals.semanticCount > 0),
    withLexicalHit: share((signals) => signals.lexicalCount > 0),
    withDualMethodHit: share((signals) => signals.dualMethodCount > 0),
    withExactTokenHit: share((signals) => signals.exactTargetsFound > 0),
  };
}
