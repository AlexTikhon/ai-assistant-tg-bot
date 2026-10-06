import { assessRetrievalConfidence, validateConfidencePolicy } from "../core/retrieval-confidence.js";
import type { ConfidencePolicy, ConfidenceReason, RetrievalSignals } from "../core/retrieval-confidence.js";
import { answerabilityMetrics, confusionMatrix } from "./answerability.js";
import type { AnswerabilityMetrics, ConfusionMatrix } from "./answerability.js";
import type { DatasetSplit } from "./dataset.js";

/** What choosing a policy needs from one evaluated question. */
export type CalibrationCase = {
  id: string;
  answerable: boolean;
  split: DatasetSplit;
  signals: RetrievalSignals;
};

type GateOutcomeRecord = {
  id: string;
  answerable: boolean;
  decision: "answer" | "abstain";
  reason: ConfidenceReason;
};

export type PolicyEvaluation = {
  policy: ConfidencePolicy;
  matrix: ConfusionMatrix;
  metrics: AnswerabilityMetrics;
  outcomes: GateOutcomeRecord[];
};

/** Runs the gate over the recorded signals. Nothing is retrieved again, so a whole grid costs microseconds. */
export function evaluatePolicy(cases: readonly CalibrationCase[], policy: ConfidencePolicy): PolicyEvaluation {
  validateConfidencePolicy(policy);
  const outcomes = cases.map(({ id, answerable, signals }): GateOutcomeRecord => {
    const { decision, reason } = assessRetrievalConfidence(signals, policy);
    return { id, answerable, decision, reason };
  });
  const matrix = confusionMatrix(outcomes);
  return { policy, matrix, metrics: answerabilityMetrics(matrix), outcomes };
}

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.round((to - from) / step) + 1 }, (_, index) => Math.round((from + index * step) * 100) / 100);

/**
 * The explicit, small search space (312 policies): similarity thresholds 0.30-0.80 in steps of 0.05, plus
 * 1.0 which no real match reaches (semantic evidence switched off); word-overlap thresholds 0.40-1.00 in
 * steps of 0.05; the identifier rule on or off. Not a parameter search in the machine-learning sense.
 */
export function policyGrid(): ConfidencePolicy[] {
  const semantic = [...range(0.3, 0.8, 0.05), 1];
  const coverage = range(0.4, 1, 0.05);
  return semantic.flatMap((minSemanticScore) =>
    coverage.flatMap((minTermCoverage) =>
      [true, false].map((requireKnownIdentifiers) => ({ minSemanticScore, minTermCoverage, requireKnownIdentifiers })),
    ),
  );
}

export type SweepResult = {
  policy: ConfidencePolicy;
  calibration: PolicyEvaluation;
  /** Reported after the choice; never consulted by it. */
  validation: PolicyEvaluation;
};

export function sweepPolicies(cases: readonly CalibrationCase[], grid: readonly ConfidencePolicy[]): SweepResult[] {
  const calibration = cases.filter((item) => item.split === "calibration");
  const validation = cases.filter((item) => item.split === "validation");
  return grid.map((policy) => ({
    policy,
    calibration: evaluatePolicy(calibration, policy),
    validation: evaluatePolicy(validation, policy),
  }));
}

export type Objective = {
  /** Smallest acceptable share of answerable questions that are let through on the calibration split. */
  minRecall: number;
};

/**
 * Orders policies by their calibration results only: among those that keep at least `minRecall`, the highest
 * specificity first (fewest unanswerable questions sent to the model); then the highest recall; then the least
 * aggressive one (lowest thresholds, identifier rule on). If no policy keeps that much recall, the best recall
 * comes first - refusing valid questions is the costlier mistake.
 */
function rankPolicies(sweep: readonly SweepResult[], objective: Objective): SweepResult[] {
  const first = sweep[0];
  if (!first || first.calibration.outcomes.length === 0) {
    throw new Error("Cannot choose a policy without calibration cases.");
  }

  const rate = (value: number | null) => value ?? 1; // nothing to get wrong on that side
  const aggressiveness = ({ policy }: SweepResult) => policy.minSemanticScore + policy.minTermCoverage;

  const feasible = sweep.filter((item) => rate(item.calibration.metrics.recall) >= objective.minRecall);
  return [...(feasible.length > 0 ? feasible : sweep)].sort((a, b) =>
    feasible.length > 0
      ? rate(b.calibration.metrics.specificity) - rate(a.calibration.metrics.specificity) ||
        rate(b.calibration.metrics.recall) - rate(a.calibration.metrics.recall) ||
        aggressiveness(a) - aggressiveness(b) ||
        Number(b.policy.requireKnownIdentifiers) - Number(a.policy.requireKnownIdentifiers)
      : rate(b.calibration.metrics.recall) - rate(a.calibration.metrics.recall) ||
        rate(b.calibration.metrics.specificity) - rate(a.calibration.metrics.specificity) ||
        aggressiveness(a) - aggressiveness(b),
  );
}

/** The best policy by calibration results (see rankPolicies). */
export function chooseFromCalibration(sweep: readonly SweepResult[], objective: Objective): SweepResult {
  return rankPolicies(sweep, objective)[0];
}

export type CalibrationReport = {
  objective: Objective;
  calibrationQueries: number;
  validationQueries: number;
  /** The best few policies on the calibration split. */
  top: SweepResult[];
  chosen: SweepResult;
  /** The policy the bot ships with, evaluated the same way. */
  committed: SweepResult;
  committedIsChosen: boolean;
};

export function buildCalibrationReport(
  cases: readonly CalibrationCase[],
  committed: ConfidencePolicy,
  objective: Objective,
  topCount = 8,
): CalibrationReport {
  const sweep = sweepPolicies(cases, [...policyGrid(), committed]);
  const ranked = rankPolicies(sweep.slice(0, -1), objective);
  const chosen = ranked[0];
  const shipped = sweep[sweep.length - 1];
  return {
    objective,
    calibrationQueries: shipped.calibration.outcomes.length,
    validationQueries: shipped.validation.outcomes.length,
    top: ranked.slice(0, topCount),
    chosen,
    committed: shipped,
    committedIsChosen: JSON.stringify(chosen.policy) === JSON.stringify(shipped.policy),
  };
}
