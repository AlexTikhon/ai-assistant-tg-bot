import { beforeEach, describe, expect, it } from "vitest";
import { RecordFeedbackUseCase } from "../../src/application/use-cases/record-feedback.use-case.js";
import { InMemoryAnswerOutcomes } from "../../src/infrastructure/memory/answer-outcomes.js";
import { SqliteFeedbackStore } from "../../src/infrastructure/sqlite/sqlite-feedback-store.js";
import { ValidationError } from "../../src/shared/errors.js";
import { createTestStores } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let outcomes: InMemoryAnswerOutcomes;
let useCase: RecordFeedbackUseCase;

const rows = () => stores.db.prepare("SELECT * FROM answer_feedback ORDER BY id").all() as Array<Record<string, unknown>>;

beforeEach(() => {
  stores = createTestStores();
  outcomes = new InMemoryAnswerOutcomes();
  useCase = new RecordFeedbackUseCase({ store: new SqliteFeedbackStore(stores.db), outcomes, now: () => new Date("2026-03-10T12:00:00.000Z") });
});

describe("RecordFeedbackUseCase", () => {
  it("stores the rating with the answer's correlation id, the user and the confidence decision metadata", async () => {
    outcomes.record("abcd1234", { mode: "shadow", decision: "answer", reason: "term-coverage", shadowDecision: "abstain", shadowReason: "weak-evidence", topSemanticScore: 0.41 });

    await useCase.execute({ userId: "42", requestId: "abcd1234", rating: "bad" });

    expect(rows()).toEqual([
      {
        id: 1,
        request_id: "abcd1234",
        user_id: "42",
        rating: "bad",
        created_at: "2026-03-10T12:00:00.000Z",
        confidence_mode: "shadow",
        decision: "answer",
        reason: "term-coverage",
        shadow_decision: "abstain",
        shadow_reason: "weak-evidence",
        top_semantic_score: 0.41,
      },
    ]);
  });

  it("still stores the rating when the outcome is no longer remembered (e.g. after a restart)", async () => {
    await useCase.execute({ userId: "42", requestId: "abcd1234", rating: "good" });

    expect(rows()[0]).toMatchObject({ rating: "good", confidence_mode: null, decision: null, top_semantic_score: null });
  });

  it("keeps one rating per user and answer: changing one's mind updates it", async () => {
    await useCase.execute({ userId: "42", requestId: "abcd1234", rating: "good" });
    await useCase.execute({ userId: "42", requestId: "abcd1234", rating: "bad" });

    expect(rows()).toHaveLength(1);
    expect(rows()[0].rating).toBe("bad");
  });

  it("treats two users' ratings of the same request id as separate", async () => {
    await useCase.execute({ userId: "1", requestId: "abcd1234", rating: "good" });
    await useCase.execute({ userId: "2", requestId: "abcd1234", rating: "bad" });

    expect(rows().map((row) => row.user_id)).toEqual(["1", "2"]);
  });

  it("rejects ids and ratings it cannot have produced", async () => {
    await expect(useCase.execute({ userId: "1", requestId: "not-an-id", rating: "good" })).rejects.toThrow(ValidationError);
    await expect(useCase.execute({ userId: "1", requestId: "abcd1234", rating: "meh" as never })).rejects.toThrow(ValidationError);
    expect(rows()).toEqual([]);
  });

  it("has no column that could hold a question, an answer or document text", () => {
    const columns = (stores.db.prepare("PRAGMA table_info(answer_feedback)").all() as Array<{ name: string }>).map((column) => column.name);

    expect(columns.sort()).toEqual(
      ["confidence_mode", "created_at", "decision", "id", "rating", "reason", "request_id", "shadow_decision", "shadow_reason", "top_semantic_score", "user_id"].sort(),
    );
  });
});
