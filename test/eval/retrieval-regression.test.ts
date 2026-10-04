import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitText } from "../../src/core/text-splitter.js";
import { checkBaseline, parseBaseline } from "../../src/eval/baseline.js";
import { compareConfigs } from "../../src/eval/compare.js";
import type { EvalSettings } from "../../src/eval/compare.js";
import { buildCalibrationReport } from "../../src/eval/calibrate.js";
import { DEFAULT_CONFIDENCE_POLICY, PASS_THROUGH_POLICY } from "../../src/core/retrieval-confidence.js";
import { describeDataset, parseDatasetFile } from "../../src/eval/dataset.js";
import { loadCorpus } from "../../src/eval/harness.js";
import { LexiconEmbeddings } from "../../src/eval/lexicon-embeddings.js";
import { REPO_ROOT } from "./support.js";

const eval_ = (...parts: string[]) => path.join(REPO_ROOT, "eval", ...parts);
const corpus = loadCorpus(eval_("corpus"));
const dataset = parseDatasetFile(fs.readFileSync(eval_("datasets", "retrieval.jsonl"), "utf-8"));
const cases = dataset.cases;
const baseline = parseBaseline(fs.readFileSync(eval_("baseline.json"), "utf-8"));
const lexicon = JSON.parse(fs.readFileSync(eval_("embedding-lexicon.json"), "utf-8")) as { concepts: Record<string, string[]> };

const squash = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

async function evaluate(overrides: Partial<EvalSettings> = {}) {
  const [result] = await compareConfigs({
    corpus,
    cases,
    embeddings: new LexiconEmbeddings(lexicon.concepts),
    base: baseline.config,
    configs: [{ name: "run", ...overrides }],
  });
  return result.report;
}

describe("the evaluation dataset", () => {
  it("is a meaningful size and covers every scenario it is meant to cover", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    expect(cases.length).toBeLessThanOrEqual(80);
    const tags = new Set(cases.flatMap((item) => item.tags));
    for (const required of ["paraphrase", "semantic-only", "exact-term", "error-code", "file-reference", "version", "quoted-phrase", "short-query", "split-info", "ambiguous", "multi-document", "no-answer", "isolation"]) {
      expect(tags, `missing scenario "${required}"`).toContain(required);
    }
    expect(cases.some((item) => item.expectedSources.length > 1)).toBe(true);
  });

  it("has an explicit version, so that metrics of different dataset versions are never compared by accident", () => {
    expect(dataset.version).toBe(2);
    expect(dataset.description).toBeTruthy();
  });

  it("has enough unanswerable questions of every kind to calibrate an answerability gate", () => {
    const unanswerable = cases.filter((item) => !item.answerable);

    expect(unanswerable.length).toBeGreaterThanOrEqual(12);
    expect(unanswerable.length).toBeLessThanOrEqual(20);
    for (const kind of ["unrelated", "missing-fact", "similar-terms", "wrong-entity", "missing-file", "missing-identifier", "cross-user"]) {
      expect(unanswerable.some((item) => item.tags.includes(kind)), `no unanswerable question of kind "${kind}"`).toBe(true);
    }
    expect(unanswerable.every((item) => item.tags.includes("no-answer") || item.tags.includes("isolation"))).toBe(true);
  });

  it("splits into calibration and validation by hand: both splits contain answerable and unanswerable questions", () => {
    const description = describeDataset(cases);

    for (const split of ["calibration", "validation"] as const) {
      expect(description.bySplit[split].answerable, `${split} has no answerable question`).toBeGreaterThanOrEqual(8);
      expect(description.bySplit[split].unanswerable, `${split} has no unanswerable question`).toBeGreaterThanOrEqual(4);
    }
    const validationShare = description.bySplit.validation.queries / description.queries;
    expect(validationShare).toBeGreaterThan(0.25);
    expect(validationShare).toBeLessThan(0.4);
  });

  it("keeps an unanswerable question unanswerable for the asking user even where another user could answer it", () => {
    const crossUser = cases.filter((item) => item.tags.includes("cross-user"));

    expect(crossUser.length).toBeGreaterThanOrEqual(3);
    expect(crossUser.every((item) => !item.answerable && item.expectedSources.length === 0)).toBe(true);
  });

  it("only refers to documents that exist for the user who asks, and to text they really contain", () => {
    for (const item of cases) {
      for (const source of item.expectedSources) {
        const document = corpus.find((doc) => doc.owner === item.user && doc.fileName === source.document);
        expect(document, `${item.id}: ${item.user}/${source.document} is not in the corpus`).toBeDefined();
        if (source.contains) {
          expect(squash(document!.content), `${item.id}: fragment not found in ${source.document}`).toContain(squash(source.contains));
        }
      }
    }
  });

  it("stays reachable when the chunking changes: some chunk always contains each expected fragment", () => {
    for (const chunkSize of [500, 700, 1000, 1500]) {
      const chunkOverlap = Math.round(chunkSize * 0.15);
      for (const item of cases) {
        for (const source of item.expectedSources.filter((expected) => expected.contains)) {
          const document = corpus.find((doc) => doc.owner === item.user && doc.fileName === source.document)!;
          const chunks = splitText(document.content.replace(/\r\n?/g, "\n"), { chunkSize, chunkOverlap }).map((chunk) => squash(chunk.content));
          expect(
            chunks.some((chunk) => chunk.includes(squash(source.contains!))),
            `${item.id}: "${source.contains}" is cut in two at chunk size ${chunkSize}`,
          ).toBe(true);
        }
      }
    }
  });

  it("has unique ids and gives the isolation scenario two owners of identical text", () => {
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    const ops = corpus.filter((doc) => doc.fileName === "ops.md");
    expect(ops.map((doc) => doc.owner).sort()).toEqual(["alice", "bob"]);
    expect(ops[0].content).toBe(ops[1].content);
  });
});

describe("the retrieval regression check", () => {
  it("is reproducible: the same data and settings always give exactly the same report", async () => {
    const runs = await Promise.all([evaluate(), evaluate(), evaluate(), evaluate()]);

    for (const run of runs.slice(1)) {
      expect(run).toEqual(runs[0]);
    }
  });

  it("passes for the shipped retrieval, with no cross-user leak", async () => {
    const report = await evaluate();
    const verdict = checkBaseline(report, baseline);

    expect(verdict.checks.filter((check) => !check.ok)).toEqual([]);
    expect(verdict.passed).toBe(true);
    expect(report.isolationViolations).toBe(0);
  });

  it("ships the confidence policy that calibration chooses - a changed dataset or retrieval means re-calibrating on purpose", async () => {
    const report = await evaluate();
    const calibration = buildCalibrationReport(
      report.cases.map((item) => ({ id: item.id, answerable: item.answerable, split: item.split, signals: item.signals })),
      DEFAULT_CONFIDENCE_POLICY,
      { minRecall: 0.9 },
    );

    expect(calibration.committedIsChosen, `calibration now prefers ${JSON.stringify(calibration.chosen.policy)}; run npm run eval:confidence`).toBe(true);
  });

  it("fails when the confidence gate lets everything through (the unanswerable questions reach the model)", async () => {
    const verdict = checkBaseline(await evaluate({ confidence: PASS_THROUGH_POLICY }), baseline);

    expect(verdict.passed).toBe(false);
    expect(verdict.checks.filter((check) => !check.ok).map((check) => check.metric)).toContain("answerabilitySpecificity");
  });

  it("fails when the gate stops checking that a named identifier exists", async () => {
    const verdict = checkBaseline(await evaluate({ confidence: { ...DEFAULT_CONFIDENCE_POLICY, requireKnownIdentifiers: false } }), baseline);

    expect(verdict.checks.filter((check) => !check.ok).map((check) => check.metric)).toContain("missing-identifier/answerabilitySpecificity");
  });

  it("fails when the exact-token bonus is switched off (an exact lexical hit loses to mediocre dual-method candidates again)", async () => {
    const verdict = checkBaseline(await evaluate({ exactTokenBonus: 0 }), baseline);

    expect(verdict.passed).toBe(false);
  });

  it("fails when the full-text path is broken (keyword search returns nothing)", async () => {
    const verdict = checkBaseline(await evaluate({ lexicalLimit: 0 }), baseline);

    expect(verdict.passed).toBe(false);
  });

  it("fails when the semantic path is broken (vector search returns nothing)", async () => {
    const verdict = checkBaseline(await evaluate({ semanticLimit: 0 }), baseline);

    expect(verdict.passed).toBe(false);
  });

  it("fails when the context is starved so that relevant chunks no longer reach it", async () => {
    const verdict = checkBaseline(await evaluate({ topK: 1, contextMaxChars: 200 }), baseline);

    expect(verdict.passed).toBe(false);
  });
});
