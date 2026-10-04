import { ValidationError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import type { AnswerOutcomes } from "../ports/answer-outcomes.js";
import type { FeedbackStore, Rating } from "../ports/feedback-store.js";

export type RecordFeedbackInput = { userId: string; requestId: string; rating: Rating };

type Dependencies = {
  store: FeedbackStore;
  /** Where the confidence decision of recent answers is remembered; optional. */
  outcomes?: AnswerOutcomes;
  now?: () => Date;
};

const REQUEST_ID = /^[0-9a-f]{8}$/;
const log = logger.child({ operation: "recordFeedback" });

/**
 * Stores a thumbs-up/down for an answer, correlated with the confidence decision made for it - the data needed
 * to find real false positives (answered, but bad) and false negatives (abstained, but the answer existed)
 * of the confidence gate. Not analytics: one small row per rating.
 */
export class RecordFeedbackUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(input: RecordFeedbackInput): Promise<void> {
    if (!REQUEST_ID.test(input.requestId) || (input.rating !== "good" && input.rating !== "bad")) {
      throw new ValidationError("That feedback could not be recorded.");
    }

    const outcome = this.deps.outcomes?.find(input.requestId);
    await this.deps.store.record({
      requestId: input.requestId,
      userId: input.userId,
      rating: input.rating,
      createdAt: (this.deps.now?.() ?? new Date()).toISOString(),
      outcome,
    });

    log.info(
      { userId: input.userId, requestId: input.requestId, rating: input.rating, decision: outcome?.decision, shadowDecision: outcome?.shadowDecision },
      "Feedback recorded",
    );
  }
}
