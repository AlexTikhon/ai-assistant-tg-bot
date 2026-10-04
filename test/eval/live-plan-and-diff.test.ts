import { describe, expect, it } from "vitest";
import { describeDataset, parseDatasetFile } from "../../src/eval/dataset.js";
import { formatExportDiff } from "../../src/eval/diff.js";
import type { EvalExport, EvalRunInfo } from "../../src/eval/export.js";
import { planLiveRun } from "../../src/eval/live-plan.js";
import type { EvalCase } from "../../src/eval/dataset.js";

const aCase = (id: string, question: string, user = "alice"): EvalCase => ({
  id,
  user,
  question,
  split: "calibration",
  answerable: false,
  expectedSources: [],
  expectedTerms: [],
  tags: [],
});

const content = "Alpha paragraph one.\n\nAlpha paragraph two.";

describe("planLiveRun", () => {
  const corpus = [
    { owner: "alice", fileName: "a.md", content },
    { owner: "bob", fileName: "a.md", content }, // identical text: the eval cache pays for it once
    { owner: "alice", fileName: "b.md", content: "Beta" },
  ];
  const chunking = { chunkSize: 1000, chunkOverlap: 100 };

  it("counts what a live run would send: unique chunk texts and unique questions", () => {
    const plan = planLiveRun({
      corpus,
      cases: [aCase("1", "What is alpha?"), aCase("2", "What is beta?"), aCase("3", "What is alpha?", "bob")],
      chunking,
    });

    expect(plan.documents).toBe(3);
    expect(plan.chunkTexts).toBe(2);
    expect(plan.questions).toBe(2);
    expect(plan.embeddingInputs).toBe(4);
  });

  it("counts API requests the way the eval indexes: one per document that has new text, one per question", () => {
    const plan = planLiveRun({ corpus, cases: [aCase("1", "q one"), aCase("2", "q two")], chunking });

    // bob's a.md is answered from the cache
    expect(plan.requests).toEqual({ documents: 2, questions: 2, total: 4 });
  });

  it("estimates tokens roughly (4 characters per token) and says it is an estimate", () => {
    const plan = planLiveRun({ corpus: [{ owner: "alice", fileName: "a.md", content: "x".repeat(400) }], cases: [aCase("1", "y".repeat(40))], chunking });

    expect(plan.approxTokens).toBe(110);
  });

  it("scales with the question limit but not with the corpus", () => {
    const many = Array.from({ length: 10 }, (_, index) => aCase(String(index), `question ${index}`));

    expect(planLiveRun({ corpus, cases: many.slice(0, 2), chunking }).requests.questions).toBe(2);
    expect(planLiveRun({ corpus, cases: many, chunking }).requests.questions).toBe(10);
    expect(planLiveRun({ corpus, cases: many.slice(0, 2), chunking }).requests.documents).toBe(
      planLiveRun({ corpus, cases: many, chunking }).requests.documents,
    );
  });

});

describe("formatExportDiff", () => {
  const datasetText = [
    JSON.stringify({ dataset: { version: 2 } }),
    JSON.stringify({ id: "a", split: "calibration", answerable: true, question: "q", expectedSources: [{ document: "a.md", contains: "x" }] }),
    JSON.stringify({ id: "n", split: "validation", answerable: false, question: "z", expectedSources: [] }),
  ].join("\n");

  function makeExport(model: string, live: boolean, overrides: (value: EvalExport) => void = () => undefined): EvalExport {
    const dataset = parseDatasetFile(datasetText);
    const info: EvalRunInfo = {
      embeddings: { model, live },
      dataset: { version: dataset.version, file: "d.jsonl", documents: 2, ...describeDataset(dataset.cases) },
      index: { fingerprint: model === "m-live" ? "bbbbbbbbbbbb" : "aaaaaaaaaaaa", profile: { embeddingModel: model, embeddingDimension: 3, chunkSize: 1000, chunkOverlap: 150, chunkingVersion: 1, extractorVersion: "x" }, chunks: 5 },
    };
    const metrics = (recall: number) => ({
      cases: 1,
      recallAt: { 1: recall, 3: recall, 5: recall },
      hitRateAt: { 1: recall, 3: recall, 5: recall },
      mrr: recall,
      candidateRecallAt: { 1: recall, 3: recall, 5: recall },
      candidateMrr: recall,
      lostToSelection: 0,
    });
    const gate = (tp: number, fn: number, fp: number, tn: number) => ({
      tp, fn, fp, tn,
      precision: tp + fp === 0 ? null : tp / (tp + fp),
      recall: tp + fn === 0 ? null : tp / (tp + fn),
      specificity: tn + fp === 0 ? null : tn / (tn + fp),
      falsePositiveRate: tn + fp === 0 ? null : fp / (tn + fp),
      falseNegativeRate: tp + fn === 0 ? null : fn / (tp + fn),
    });
    const value = {
      exportVersion: 1,
      embeddings: info.embeddings,
      dataset: info.dataset,
      index: info.index,
      configuration: {
        chunking: { chunkSize: 1000, chunkOverlap: 150 },
        retrieval: { topK: 5, minScore: 0.2, semanticLimit: 20, lexicalLimit: 20, rrfK: 60, contextMaxChars: 6000, semanticWeight: 1, lexicalWeight: 1, exactTokenBonus: 1 },
        confidencePolicy: { minSemanticScore: 0.5, minTermCoverage: 0.6, requireKnownIdentifiers: true },
      },
      metrics: { ks: [1, 3, 5], overall: metrics(live ? 0.5 : 1), termCoverage: 1, noAnswer: { cases: 1, withContext: 1 }, isolationViolations: 0 },
      answerability: live ? gate(1, 0, 1, 0) : gate(1, 0, 0, 1),
      bySplit: {},
      byTag: {},
      signals: {} as never,
      cases: [],
    } as unknown as EvalExport;
    overrides(value);
    return value;
  }

  it("puts the retrieval metrics and the answerability metrics of both runs next to each other", () => {
    const text = formatExportDiff({ label: "offline", result: makeExport("m-offline", false) }, { label: "live", result: makeExport("m-live", true) });

    expect(text).toMatch(/Recall@1\s+1\.00\s+0\.50\s+-0\.50/);
    expect(text).toMatch(/MRR\s+1\.00\s+0\.50\s+-0\.50/);
    expect(text).toMatch(/specificity\s+1\.00\s+0\.00\s+-1\.00/);
    expect(text).toMatch(/TP\/FN\/FP\/TN\s+1\/0\/0\/1\s+1\/0\/1\/0/);
    expect(text).toContain("m-offline");
    expect(text).toContain("m-live");
  });

  it("says that cosine scores of different embedding models are not comparable, and compares none", () => {
    const text = formatExportDiff({ label: "a", result: makeExport("m-offline", false) }, { label: "b", result: makeExport("m-live", true) });

    expect(text).toMatch(/cosine/i);
    expect(text).toMatch(/not comparable/i);
    expect(text).not.toMatch(/semantic score/i);
  });

  it("warns when the runs did not use the same dataset version or the same queries", () => {
    const other = makeExport("m-live", true, (value) => {
      value.dataset = { ...value.dataset, version: 3, queries: 1 };
    });

    const text = formatExportDiff({ label: "a", result: makeExport("m-offline", false) }, { label: "b", result: other });

    expect(text).toMatch(/WARNING.*dataset version 2 vs 3/);
    expect(text).toMatch(/WARNING.*2 vs 1 queries/);
  });

  it("warns when the chunking differs, since fingerprints already differ for the embedding model alone", () => {
    const other = makeExport("m-live", true, (value) => {
      value.index = { ...value.index, profile: { ...value.index.profile, chunkSize: 500 } };
    });

    expect(formatExportDiff({ label: "a", result: makeExport("m-offline", false) }, { label: "b", result: other })).toMatch(/WARNING.*chunk/i);
  });

  it("does not warn when only the embedding model differs", () => {
    const text = formatExportDiff({ label: "a", result: makeExport("m-offline", false) }, { label: "b", result: makeExport("m-live", true) });

    expect(text).not.toContain("WARNING");
  });
});

