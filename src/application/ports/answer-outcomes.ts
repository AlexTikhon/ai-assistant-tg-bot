import type { ConfidenceMode, ConfidenceReason } from "../../core/retrieval-confidence.js";

/**
 * What the confidence gate decided for one answer, as small structured facts. It is what feedback is
 * correlated with: labels and one number, never the question, an answer or any document text.
 */
export type ConfidenceOutcome = {
  mode: ConfidenceMode;
  /** What the user actually got: an answer, or an abstention. */
  decision: "answer" | "abstain";
  reason: ConfidenceReason;
  /** Shadow mode only: what an enforcing gate would have done instead. */
  shadowDecision?: "answer" | "abstain";
  shadowReason?: ConfidenceReason;
  topSemanticScore: number | null;
};

/** Remembers recent outcomes by request id for a short while, so a later piece of feedback can refer to one. */
export interface AnswerOutcomes {
  record(requestId: string, outcome: ConfidenceOutcome): void;
  find(requestId: string): ConfidenceOutcome | undefined;
}
