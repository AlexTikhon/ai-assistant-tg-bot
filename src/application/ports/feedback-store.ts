import type { ConfidenceOutcome } from "./answer-outcomes.js";

export type Rating = "good" | "bad";

/** A user's verdict on one answer. Small and structured on purpose: no question, no answer, no document text. */
export type AnswerFeedback = {
  /** Correlation id of the answer (the request id of the update that produced it). */
  requestId: string;
  userId: string;
  rating: Rating;
  createdAt: string;
  /** What the confidence gate decided for that answer, when it is still known. */
  outcome?: ConfidenceOutcome;
};

export interface FeedbackStore {
  /** One rating per user and answer: a second one replaces the first. */
  record(feedback: AnswerFeedback): Promise<void>;
}
