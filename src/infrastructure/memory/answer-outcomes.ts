import type { AnswerOutcomes, ConfidenceOutcome } from "../../application/ports/answer-outcomes.js";

/**
 * A bounded in-memory journal of the latest answer outcomes (oldest forgotten first). Not persisted on
 * purpose: it only exists so that a thumbs-up/down pressed shortly after an answer can carry that answer's
 * confidence decision. After a restart feedback is still stored, just without that metadata.
 */
export class InMemoryAnswerOutcomes implements AnswerOutcomes {
  private readonly outcomes = new Map<string, ConfidenceOutcome>();

  constructor(private readonly capacity = 1000) {}

  record(requestId: string, outcome: ConfidenceOutcome) {
    this.outcomes.delete(requestId);
    this.outcomes.set(requestId, outcome);
    while (this.outcomes.size > this.capacity) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
  }

  find(requestId: string) {
    return this.outcomes.get(requestId);
  }

  get size() {
    return this.outcomes.size;
  }
}
