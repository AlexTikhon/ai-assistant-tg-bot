import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIDENCE_POLICY } from "../../src/core/retrieval-confidence.js";
import { describeDataset, parseDatasetFile } from "../../src/eval/dataset.js";
import { buildEvalExport, EVAL_EXPORT_VERSION } from "../../src/eval/export.js";
import type { EvalRunInfo } from "../../src/eval/export.js";
import { buildEvalIndex } from "../../src/eval/harness.js";
import type { EvalIndex } from "../../src/eval/harness.js";
import { LexiconEmbeddings } from "../../src/eval/lexicon-embeddings.js";
import { runEvaluation } from "../../src/eval/runner.js";

const embeddings = new LexiconEmbeddings({ tax: ["tax", "levy"], blocked: ["jam", "jammed"] });
const SECRET_SENTENCE = "The vault combination is seven seven nine";
const corpus = [
  { owner: "alice", fileName: "tax.md", content: `The annual tax return is due on April 15. ${SECRET_SENTENCE}.` },
  { owner: "alice", fileName: "ops.md", content: "ECONNRESET means the broker closed the connection." },
];

const datasetText = [
  JSON.stringify({ dataset: { version: 7, description: "unit test dataset" } }),
  JSON.stringify({
    id: "tax",
    split: "calibration",
    answerable: true,
    question: "annual tax return",
    expectedSources: [{ document: "tax.md", contains: "annual tax return is due" }],
    tags: ["paraphrase"],
  }),
  JSON.stringify({ id: "none", split: "validation", answerable: false, question: "zzzz qqqq", expectedSources: [], tags: ["no-answer"] }),
].join("\n");

let index: EvalIndex | undefined;
afterEach(() => {
  index?.close();
  index = undefined;
});

async function exportOnce() {
  const dataset = parseDatasetFile(datasetText);
  index = await buildEvalIndex(corpus, { chunkSize: 400, chunkOverlap: 40 }, embeddings);
  const settings = { topK: 3, minScore: 0.2, semanticLimit: 10, lexicalLimit: 10, rrfK: 60, contextMaxChars: 5000 };
  const report = await runEvaluation({ cases: dataset.cases, index, embeddings, retrieval: settings });
  const info: EvalRunInfo = {
    embeddings: { model: embeddings.model, live: false },
    dataset: { version: dataset.version, description: dataset.description, file: "datasets/unit.jsonl", documents: index.documentCount, ...describeDataset(dataset.cases) },
    index: { fingerprint: index.fingerprint, profile: index.profile, chunks: index.chunkCount },
  };
  return { exported: buildEvalExport(report, info), report };
}

describe("buildEvalExport", () => {
  it("states the dataset version and size so that metrics of different dataset versions are never confused", async () => {
    const { exported } = await exportOnce();

    expect(exported.exportVersion).toBe(EVAL_EXPORT_VERSION);
    expect(exported.dataset).toMatchObject({
      version: 7,
      description: "unit test dataset",
      documents: 2,
      queries: 2,
      answerable: 1,
      unanswerable: 1,
      bySplit: { calibration: { queries: 1 }, validation: { queries: 1 } },
    });
  });

  it("identifies the index recipe by profile and fingerprint", async () => {
    const { exported } = await exportOnce();

    expect(exported.index.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(exported.index.profile).toMatchObject({ embeddingModel: embeddings.model, chunkSize: 400, chunkOverlap: 40 });
    expect(exported.index.chunks).toBeGreaterThan(0);
  });

  it("spells out the whole configuration including defaults, so a run can be reproduced", async () => {
    const { exported } = await exportOnce();

    expect(exported.configuration.retrieval).toEqual({
      topK: 3,
      minScore: 0.2,
      semanticLimit: 10,
      lexicalLimit: 10,
      rrfK: 60,
      contextMaxChars: 5000,
      semanticWeight: 1,
      lexicalWeight: 1,
      exactTokenBonus: 0,
    });
    expect(exported.configuration.chunking).toEqual({ chunkSize: 400, chunkOverlap: 40 });
    expect(exported.configuration.confidencePolicy).toEqual(DEFAULT_CONFIDENCE_POLICY);
  });

  it("carries the metrics, the per-tag and per-split breakdown, the answerability results and one entry per query", async () => {
    const { exported } = await exportOnce();

    expect(exported.metrics.overall.recallAt[5]).toBe(1);
    expect(exported.byTag.paraphrase.answerability).toMatchObject({ tp: 1 });
    expect(exported.bySplit.validation.answerability).toMatchObject({ tn: 1 });
    expect(exported.answerability).toMatchObject({ tp: 1, tn: 1, fp: 0, fn: 0 });
    expect(exported.cases.map((item) => [item.id, item.decision])).toEqual([
      ["tax", "answer"],
      ["none", "abstain"],
    ]);
    expect(exported.cases[0].signals.topSemanticScore).not.toBeUndefined();
  });

  it("contains no document text and no secrets: ground truth fragments are left out", async () => {
    const { exported } = await exportOnce();
    const json = JSON.stringify(exported);

    expect(json).not.toContain(SECRET_SENTENCE);
    expect(json).not.toContain("annual tax return is due");
    expect(json).not.toMatch(/sk-[A-Za-z0-9]|apiKey|botToken/);
    expect(exported.cases[0].expectedSources).toEqual([{ document: "tax.md" }]);
  });

  it("is reproducible: the same inputs give byte-identical JSON", async () => {
    const first = JSON.stringify((await exportOnce()).exported);
    const second = JSON.stringify((await exportOnce()).exported);

    expect(second).toBe(first);
  });

  it("is valid JSON without NaN or Infinity", async () => {
    const json = JSON.stringify((await exportOnce()).exported);

    expect(json).not.toMatch(/NaN|Infinity/);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
