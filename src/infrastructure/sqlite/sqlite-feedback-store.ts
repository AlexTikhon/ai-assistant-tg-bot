import type Database from "better-sqlite3";
import type { AnswerFeedback, FeedbackStore } from "../../application/ports/feedback-store.js";

export class SqliteFeedbackStore implements FeedbackStore {
  private readonly upsert;

  constructor(db: Database.Database) {
    // A second rating of the same answer by the same user replaces the first; metadata already known is kept
    // when the second rating arrives after the in-memory outcome was forgotten.
    this.upsert = db.prepare(
      `INSERT INTO answer_feedback (request_id, user_id, rating, created_at, confidence_mode, decision, reason, shadow_decision, shadow_reason, top_semantic_score)
       VALUES (@requestId, @userId, @rating, @createdAt, @mode, @decision, @reason, @shadowDecision, @shadowReason, @topSemanticScore)
       ON CONFLICT (request_id, user_id) DO UPDATE SET
         rating = excluded.rating, created_at = excluded.created_at,
         confidence_mode = COALESCE(excluded.confidence_mode, confidence_mode), decision = COALESCE(excluded.decision, decision),
         reason = COALESCE(excluded.reason, reason), shadow_decision = COALESCE(excluded.shadow_decision, shadow_decision),
         shadow_reason = COALESCE(excluded.shadow_reason, shadow_reason),
         top_semantic_score = COALESCE(excluded.top_semantic_score, top_semantic_score)`,
    );
  }

  async record(feedback: AnswerFeedback) {
    const { outcome } = feedback;
    this.upsert.run({
      requestId: feedback.requestId,
      userId: feedback.userId,
      rating: feedback.rating,
      createdAt: feedback.createdAt,
      mode: outcome?.mode ?? null,
      decision: outcome?.decision ?? null,
      reason: outcome?.reason ?? null,
      shadowDecision: outcome?.shadowDecision ?? null,
      shadowReason: outcome?.shadowReason ?? null,
      topSemanticScore: outcome?.topSemanticScore ?? null,
    });
  }
}
