import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { splitText } from "../../src/core/text-splitter.js";
import { checkBaseline, parseBaseline } from "../../src/eval/baseline.js";
import { compareConfigs } from "../../src/eval/compare.js";
import type { EvalSettings } from "../../src/eval/compare.js";
import { parseDataset } from "../../src/eval/dataset.js";
import { loadCorpus } from "../../src/eval/harness.js";
import { LexiconEmbeddings } from "../../src/eval/lexicon-embeddings.js";
import { REPO_ROOT } from "./support.js";

const eval_ = (...parts: string[]) => path.join(REPO_ROOT, "eval", ...parts);
const corpus = loadCorpus(eval_("corpus"));
const cases = parseDataset(fs.readFileSync(eval_("datasets", "retrieval.jsonl"), "utf-8"));
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
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.length).toBeLessThanOrEqual(35);
    const tags = new Set(cases.flatMap((item) => item.tags));
    for (const required of ["paraphrase", "exact-term", "error-code", "file-reference", "split-info", "ambiguous", "multi-document", "no-answer", "isolation"]) {
      expect(tags, `missing scenario "${required}"`).toContain(required);
    }
    expect(cases.some((item) => item.expectedSources.length > 1)).toBe(true);
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
