import { beforeEach, describe, expect, it } from "vitest";
import { HybridRetriever } from "../../src/application/hybrid-retriever.js";
import type { RetrievalOptions } from "../../src/application/hybrid-retriever.js";
import { AnswerQuestionUseCase } from "../../src/application/use-cases/answer-question.use-case.js";
import type { ConfidenceMode } from "../../src/core/retrieval-confidence.js";
import { runWithRequestId } from "../../src/shared/request-context.js";
import { InMemoryAnswerOutcomes } from "../../src/infrastructure/memory/answer-outcomes.js";
import { answered, createTestStores, FakeChatModel, KeywordEmbeddings, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let embeddings: KeywordEmbeddings;
let chatModel: FakeChatModel;

const base: RetrievalOptions = { topK: 3, minScore: 0.2, semanticLimit: 10, lexicalLimit: 10, contextMaxChars: 10_000 };
const policy = { minSemanticScore: 0.9, minTermCoverage: 0.9, requireKnownIdentifiers: true };

const SECRET_TEXT = "the cat sleeps on the sofa; internal codename BLUEBERRY-7781";
const WEAK_QUESTION = "cat tax dog space confidential-roadmap"; // far from the document: the gate would abstain

type Entry = { fields: Record<string, unknown>; message: string };
function createLog() {
  const entries: Entry[] = [];
  const record = (fields: Record<string, unknown>, message: string) => void entries.push({ fields, message });
  return { entries, info: record, warn: record };
}

function setup(mode: ConfidenceMode | undefined, extra: { logQuestions?: boolean; outcomes?: InMemoryAnswerOutcomes } = {}) {
  const log = createLog();
  const useCase = new AnswerQuestionUseCase({
    retriever: new HybridRetriever({ embeddings, vectorStore: stores.vectorStore, options: { ...base, confidence: policy, confidenceMode: mode } }),
    chatModel,
    options: { logQuestions: extra.logQuestions },
    outcomes: extra.outcomes,
    log,
  });
  return { useCase, log };
}

const shadowEntries = (log: ReturnType<typeof createLog>) => log.entries.filter((entry) => entry.message === "Confidence gate shadow decision");

beforeEach(async () => {
  stores = createTestStores();
  embeddings = new KeywordEmbeddings();
  chatModel = new FakeChatModel("The cat sleeps. [1]");
  await stores.documents.saveWithChunks(makeDocument({ id: "doc-1", userId: "user-1", fileName: "pets.md" }), [
    makeChunk({ documentId: "doc-1", userId: "user-1", chunkIndex: 0, content: SECRET_TEXT, embedding: await embeddings.embedQuery(SECRET_TEXT) }),
  ]);
});

describe("retrieval confidence modes", () => {
  it("off: weak evidence is not judged at all - the model is asked, and nothing is logged about a decision", async () => {
    const { useCase, log } = setup("off");

    const result = await useCase.execute({ userId: "user-1", question: WEAK_QUESTION });

    expect(result.kind).toBe("answered");
    expect(chatModel.calls).toHaveLength(1);
    expect(shadowEntries(log)).toHaveLength(0);
  });

  it("enforce: weak evidence is answered with an abstention and no chat model call", async () => {
    const { useCase } = setup("enforce");

    const result = await useCase.execute({ userId: "user-1", question: WEAK_QUESTION });

    expect(result).toStrictEqual({ kind: "insufficient-evidence", reason: "weak-evidence" });
    expect(chatModel.calls).toHaveLength(0);
  });

  it("a policy without a mode behaves as enforce (the behaviour that existed before modes)", async () => {
    const { useCase } = setup(undefined);

    expect((await useCase.execute({ userId: "user-1", question: WEAK_QUESTION })).kind).toBe("insufficient-evidence");
  });

  it("shadow: never abstains - the user gets exactly the answer they would get without a gate", async () => {
    const withGateOff = setup("off");
    const shadow = setup("shadow");

    const reference = answered(await withGateOff.useCase.execute({ userId: "user-1", question: WEAK_QUESTION }));
    chatModel.calls.length = 0;
    const result = answered(await shadow.useCase.execute({ userId: "user-1", question: WEAK_QUESTION }));

    expect(result).toEqual(reference);
    expect(chatModel.calls).toHaveLength(1);
  });

  it("shadow: computes the decision and logs what would have happened", async () => {
    const { useCase, log } = setup("shadow");

    await useCase.execute({ userId: "user-1", question: WEAK_QUESTION });

    const [entry] = shadowEntries(log);
    expect(entry.fields).toMatchObject({
      userId: "user-1",
      mode: "shadow",
      decision: "abstain",
      reason: "weak-evidence",
      wouldAbstain: true,
      answered: true, // production behaviour was unchanged
      threshold: 0.9,
      candidateCount: expect.any(Number),
      semanticScore: expect.any(Number),
      termCoverage: expect.any(Number),
      exactTargets: expect.any(Number),
      exactTargetsFound: expect.any(Number),
      durationMs: expect.any(Number),
    });
  });

  it("shadow: also logs the cases where the gate agrees to answer, so false positives can be measured", async () => {
    const { useCase, log } = setup("shadow");

    await useCase.execute({ userId: "user-1", question: "cat sofa internal codename" });

    expect(shadowEntries(log)[0].fields).toMatchObject({ decision: "answer", wouldAbstain: false });
  });

  it("shadow: logs a question that finds nothing as would-abstain too", async () => {
    stores = createTestStores();
    const { useCase, log } = setup("shadow");

    await useCase.execute({ userId: "user-1", question: "anything at all" });

    expect(shadowEntries(log)[0].fields).toMatchObject({ decision: "abstain", reason: "no-candidates", candidateCount: 0 });
  });

  it("the confidence log contains only numbers and labels: never the question, a document, the context or a vector - even with LOG_QUESTIONS on", async () => {
    const { useCase, log } = setup("shadow", { logQuestions: true });

    await useCase.execute({ userId: "user-1", question: WEAK_QUESTION });

    const serialized = JSON.stringify(shadowEntries(log).map((entry) => ({ ...entry.fields, message: entry.message })));
    expect(serialized).not.toContain("confidential-roadmap");
    expect(serialized).not.toContain("BLUEBERRY");
    expect(serialized).not.toContain("sleeps");
    expect(serialized).not.toMatch(/\[\s*[-\d.]+\s*,\s*[-\d.]+/); // no vector
    for (const value of Object.values(shadowEntries(log)[0].fields)) {
      // null: a signal that does not exist for this question (e.g. no gap with a single candidate).
      expect(value === null || ["number", "boolean", "string"].includes(typeof value)).toBe(true);
    }
  });

  it("records the outcome under the request id for feedback, in every mode", async () => {
    const outcomes = new InMemoryAnswerOutcomes();
    const { useCase } = setup("shadow", { outcomes });

    await runWithRequestId("req00001", () => useCase.execute({ userId: "user-1", question: WEAK_QUESTION }));

    expect(outcomes.find("req00001")).toMatchObject({
      mode: "shadow",
      decision: "answer",
      shadowDecision: "abstain",
      shadowReason: "weak-evidence",
      topSemanticScore: expect.any(Number),
    });
  });

  it("records nothing without a request id", async () => {
    const outcomes = new InMemoryAnswerOutcomes();
    const { useCase } = setup("shadow", { outcomes });

    await useCase.execute({ userId: "user-1", question: WEAK_QUESTION });

    expect(outcomes.size).toBe(0);
  });
});

describe("InMemoryAnswerOutcomes", () => {
  it("is bounded: the oldest outcomes are forgotten, the newest kept", () => {
    const outcomes = new InMemoryAnswerOutcomes(3);
    const outcome = { mode: "enforce" as const, decision: "answer" as const, reason: "semantic" as const, topSemanticScore: 0.6 };

    ["a", "b", "c", "d"].forEach((id) => outcomes.record(id, outcome));

    expect(outcomes.find("a")).toBeUndefined();
    expect(outcomes.find("d")).toEqual(outcome);
    expect(outcomes.size).toBe(3);
  });
});
