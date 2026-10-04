import { afterEach, describe, expect, it } from "vitest";
import type { VectorStore } from "../../src/application/ports/vector-store.js";
import { DEFAULT_CONFIDENCE_POLICY } from "../../src/core/retrieval-confidence.js";
import { buildEvalIndex } from "../../src/eval/harness.js";
import type { EvalIndex } from "../../src/eval/harness.js";
import { LexiconEmbeddings } from "../../src/eval/lexicon-embeddings.js";
import { runEvaluation } from "../../src/eval/runner.js";
import type { RetrievalSettings } from "../../src/eval/runner.js";
import type { EvalCase } from "../../src/eval/dataset.js";

const embeddings = new LexiconEmbeddings({
  feeding: ["feeder", "dispenser", "kibble"],
  blocked: ["jam", "jammed", "stuck"],
  tax: ["tax", "levy"],
});

const corpus = [
  { owner: "alice", fileName: "feeder.md", content: "How to clear a jammed feeder: unplug it and remove the paddle." },
  { owner: "alice", fileName: "tax.md", content: "The annual tax return is due on April 15. Keep every receipt." },
  { owner: "alice", fileName: "ops.md", content: "ECONNRESET means the broker closed the connection." },
  { owner: "bob", fileName: "ops.md", content: "ECONNRESET means the broker closed the connection." },
  { owner: "bob", fileName: "secret.md", content: "The treasure map is hidden under the old oak." },
];

const settings: RetrievalSettings = { topK: 3, minScore: 0.2, semanticLimit: 10, lexicalLimit: 10, rrfK: 60, contextMaxChars: 5000 };
const chunking = { chunkSize: 400, chunkOverlap: 40 };

const makeCase = (overrides: Partial<EvalCase> & Pick<EvalCase, "id" | "question">): EvalCase => ({
  user: "alice",
  split: "calibration",
  answerable: (overrides.expectedSources?.length ?? 0) > 0,
  expectedSources: [],
  expectedTerms: [],
  tags: [],
  ...overrides,
});

let index: EvalIndex | undefined;
afterEach(() => {
  index?.close();
  index = undefined;
});

async function evaluate(cases: EvalCase[], overrides: Partial<RetrievalSettings> = {}, store?: (real: VectorStore) => VectorStore) {
  index = await buildEvalIndex(corpus, chunking, embeddings);
  return runEvaluation({
    cases,
    index: store ? { ...index, vectorStore: store(index.vectorStore) } : index,
    embeddings,
    retrieval: { ...settings, ...overrides },
  });
}

describe("runEvaluation", () => {
  it("scores a paraphrase found only semantically and an exact term found lexically", async () => {
    const report = await evaluate([
      makeCase({
        id: "paraphrase",
        question: "my dispenser is stuck",
        expectedSources: [{ document: "feeder.md", contains: "clear a jammed feeder" }],
        tags: ["paraphrase"],
      }),
      makeCase({
        id: "exact",
        question: "ECONNRESET",
        expectedSources: [{ document: "ops.md", contains: "ECONNRESET means" }],
        tags: ["exact-term"],
      }),
    ]);

    const [paraphrase, exact] = report.cases;
    expect(paraphrase).toMatchObject({ id: "paraphrase", hit: true, reciprocalRank: 1, matchRanks: [1] });
    expect(paraphrase.firstRelevant).toMatchObject({ document: "feeder.md", semanticRank: 1, fusedRank: 1 });
    expect(paraphrase.firstRelevant?.lexicalRank).toBeUndefined(); // no shared word: invisible to keyword search
    expect(exact.firstRelevant).toMatchObject({ document: "ops.md", lexicalRank: 1 });
    expect(report.overall).toMatchObject({ cases: 2, mrr: 1 });
    expect(report.overall.recallAt[1]).toBe(1);
  });

  it("reports hit/miss, the retrieved list and the reciprocal rank of a miss", async () => {
    const report = await evaluate([
      makeCase({ id: "miss", question: "annual tax return", expectedSources: [{ document: "feeder.md", contains: "paddle" }] }),
    ]);

    const [result] = report.cases;
    expect(result.hit).toBe(false);
    expect(result.reciprocalRank).toBe(0);
    expect(result.matchRanks).toEqual([null]);
    expect(result.retrieved[0]).toMatchObject({ rank: 1, document: "tax.md", relevant: false });
    expect(report.overall.mrr).toBe(0);
  });

  it("scores cases with several expected sources by recall", async () => {
    const report = await evaluate([
      makeCase({
        id: "two",
        question: "tax return and jammed feeder",
        expectedSources: [
          { document: "tax.md", contains: "annual tax return" },
          { document: "feeder.md", contains: "jammed feeder" },
          { document: "ops.md", contains: "this text is nowhere" },
        ],
      }),
    ]);

    expect(report.cases[0].matchRanks.filter((rank) => rank !== null)).toHaveLength(2);
    expect(report.overall.recallAt[5]).toBeCloseTo(2 / 3);
  });

  it("evaluates no-answer cases separately and counts those that still return context", async () => {
    const report = await evaluate([
      makeCase({ id: "abstain", question: "zzzz qqqq", expectedSources: [], tags: ["no-answer"] }),
      makeCase({ id: "noisy", question: "tax", expectedSources: [], tags: ["no-answer"] }),
      makeCase({ id: "real", question: "tax", expectedSources: [{ document: "tax.md", contains: "April 15" }] }),
    ]);

    expect(report.overall.cases).toBe(1); // no-answer cases are not part of recall / MRR
    expect(report.noAnswer).toEqual({ cases: 2, withContext: 1 });
    expect(report.cases[0].answerable).toBe(false);
  });

  it("breaks results down by tag", async () => {
    const report = await evaluate([
      makeCase({ id: "a", question: "tax", expectedSources: [{ document: "tax.md", contains: "April 15" }], tags: ["exact-term", "x"] }),
      makeCase({ id: "b", question: "tax", expectedSources: [{ document: "feeder.md", contains: "paddle" }], tags: ["exact-term"] }),
    ]);

    expect(report.byTag["exact-term"].cases).toBe(2);
    expect(report.byTag["exact-term"].mrr).toBe(0.5);
    expect(report.byTag.x.cases).toBe(1);
    expect(report.byTag.x.mrr).toBe(1);
  });

  it("measures how much of the expected terms the retrieved context contains", async () => {
    const report = await evaluate([
      makeCase({
        id: "terms",
        question: "annual tax return",
        expectedSources: [{ document: "tax.md", contains: "April 15" }],
        expectedTerms: ["April 15", "receipt", "not in the corpus"],
      }),
    ]);

    expect(report.cases[0].termCoverage).toBeCloseTo(2 / 3);
    expect(report.termCoverage).toBeCloseTo(2 / 3);
  });
});

describe("evaluation of user isolation", () => {
  it("finds the right copy when two users own identical text, and reports no violations", async () => {
    const report = await evaluate([
      makeCase({ id: "bob", user: "bob", question: "ECONNRESET", expectedSources: [{ document: "ops.md", contains: "ECONNRESET means" }] }),
      makeCase({ id: "alice", user: "alice", question: "ECONNRESET", expectedSources: [{ document: "ops.md", contains: "ECONNRESET means" }] }),
      makeCase({ id: "bob-cannot-see-alice", user: "bob", question: "jammed feeder", expectedSources: [] }),
    ]);

    expect(report.isolationViolations).toBe(0);
    expect(report.cases.every((result) => result.isolationViolations === 0)).toBe(true);
    expect(report.cases[0].retrieved.every((chunk) => chunk.owner === "bob")).toBe(true);
    expect(report.cases[1].retrieved.every((chunk) => chunk.owner === "alice")).toBe(true);
    expect(report.cases[2].retrieved.every((chunk) => chunk.owner === "bob")).toBe(true);
    expect(report.overall.mrr).toBe(1);
  });

  it("detects a store that leaks documents across users (the check itself works)", async () => {
    // A store that ignores the user filter, as a regression in the SQL would.
    const leaky = (real: VectorStore): VectorStore => ({
      ...real,
      searchSimilar: (search) => real.searchSimilar({ ...search, userId: "alice" }),
      searchLexical: (search) => real.searchLexical({ ...search, userId: "alice" }),
      getChunks: (_user, ids) => real.getChunks("alice", ids),
    });

    const report = await evaluate(
      [makeCase({ id: "leak", user: "bob", question: "jammed feeder", expectedSources: [] })],
      {},
      leaky,
    );

    expect(report.isolationViolations).toBeGreaterThan(0);
    expect(report.cases[0].isolationViolations).toBeGreaterThan(0);
  });
});

describe("evidence lost to context selection", () => {
  it("shows when an expected chunk was a candidate but de-duplication kept it out of the context", async () => {
    // The same text in two documents: both are ranked candidates, but only one may enter the context.
    const text = "unplug the feeder and remove the jammed paddle";
    index = await buildEvalIndex(
      [
        { owner: "alice", fileName: "a.md", content: text },
        // A trailing newline makes the bytes differ (identical uploads are one document) but not the chunk text.
        { owner: "alice", fileName: "b.md", content: `${text}\n` },
      ],
      chunking,
      embeddings,
    );

    const report = await runEvaluation({
      cases: [
        makeCase({
          id: "dup",
          question: "jammed feeder paddle",
          expectedSources: [
            { document: "a.md", contains: "unplug the feeder" },
            { document: "b.md", contains: "unplug the feeder" },
          ],
        }),
      ],
      index,
      embeddings,
      retrieval: settings,
    });

    const [result] = report.cases;
    expect(result.candidateMatchRanks.every((rank) => rank !== null)).toBe(true);
    expect(result.matchRanks.filter((rank) => rank === null)).toHaveLength(1);
    expect(result.lostToSelection).toBe(true);
    expect(report.overall.lostToSelection).toBe(1);
    expect(report.overall.candidateRecallAt[5]).toBe(1);
    expect(report.overall.recallAt[5]).toBe(0.5);
  });
});

describe("answerability in the evaluation", () => {
  const strict = { minSemanticScore: 0.5, minTermCoverage: 0.6, requireKnownIdentifiers: true };

  const answerabilityCases = [
    makeCase({ id: "tax", question: "annual tax return April 15", expectedSources: [{ document: "tax.md", contains: "April 15" }], tags: ["paraphrase"] }),
    makeCase({ id: "exact", question: "ECONNRESET", expectedSources: [{ document: "ops.md", contains: "ECONNRESET means" }], tags: ["exact-term"], split: "validation" }),
    makeCase({ id: "nothing", question: "zzzz qqqq", answerable: false, tags: ["no-answer"] }),
    makeCase({ id: "unknown-code", question: "ECONNREFUSED broker connection", answerable: false, tags: ["no-answer", "exact-term"], split: "validation" }),
    makeCase({ id: "weak", question: "tax", answerable: false, tags: ["no-answer"] }),
  ];

  it("applies the confidence gate to every question and builds the confusion matrix", async () => {
    const report = await evaluate(answerabilityCases, { confidence: strict });

    const decisions = Object.fromEntries(report.cases.map((result) => [result.id, result.decision]));
    expect(decisions).toEqual({ tax: "answer", exact: "answer", nothing: "abstain", "unknown-code": "abstain", weak: "answer" });
    expect(report.cases.find((result) => result.id === "unknown-code")?.reason).toBe("identifier-not-found");
    expect(report.cases.find((result) => result.id === "nothing")?.reason).toBe("no-candidates");
    expect(report.answerability).toMatchObject({ tp: 2, fn: 0, fp: 1, tn: 2, recall: 1 });
    expect(report.answerability.specificity).toBeCloseTo(2 / 3);
    expect(report.policy).toEqual(strict);
  });

  it("reports the calibration and the validation split separately", async () => {
    const report = await evaluate(answerabilityCases, { confidence: strict });

    expect(report.bySplit.calibration.queries).toBe(3);
    expect(report.bySplit.validation.queries).toBe(2);
    expect(report.bySplit.calibration.answerability).toMatchObject({ tp: 1, fp: 1, tn: 1, fn: 0 });
    expect(report.bySplit.validation.answerability).toMatchObject({ tp: 1, fp: 0, tn: 1, fn: 0 });
    expect(report.bySplit.validation.retrieval.cases).toBe(1);
    expect(report.bySplit.validation.retrieval.recallAt[1]).toBe(1);
  });

  it("breaks the answerability down by tag too", async () => {
    const report = await evaluate(answerabilityCases, { confidence: strict });

    expect(report.byTag["no-answer"].answerability).toMatchObject({ tp: 0, fp: 1, tn: 2 });
    expect(report.byTag["no-answer"].queries).toBe(3);
    expect(report.byTag["exact-term"].answerability).toMatchObject({ tp: 1, tn: 1 });
  });

  it("summarises the evidence of answerable and unanswerable questions", async () => {
    const report = await evaluate(answerabilityCases, { confidence: strict });

    expect(report.signals.answerable.cases).toBe(2);
    expect(report.signals.unanswerable.cases).toBe(3);
    expect(report.signals.answerable.withLexicalHit).toBe(1);
    expect(report.signals.unanswerable.withLexicalHit).toBeCloseTo(2 / 3);
  });

  it("records the best rank of an expected source among the candidates", async () => {
    const report = await evaluate(answerabilityCases, { confidence: strict });

    expect(report.cases.find((result) => result.id === "tax")?.expectedSourceRank).toBe(1);
    expect(report.cases.find((result) => result.id === "nothing")?.expectedSourceRank).toBeNull();
  });

  it("uses the committed default policy when none is configured", async () => {
    const report = await evaluate(answerabilityCases);

    expect(report.policy).toEqual(DEFAULT_CONFIDENCE_POLICY);
  });

  it("takes the exact-token bonus from the settings", async () => {
    const withBonus = await evaluate(
      [makeCase({ id: "e", question: "ECONNRESET", expectedSources: [{ document: "ops.md", contains: "ECONNRESET means" }] })],
      { exactTokenBonus: 1 },
    );

    expect(withBonus.cases[0].retrieved[0].exactMatches).toBe(1);
  });
});
