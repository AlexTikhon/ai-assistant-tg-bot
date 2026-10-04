import fs from "node:fs";
import path from "node:path";
import { loadToolConfig, openAiConfig } from "../config/config.js";
import type { EmbeddingsProvider } from "../application/ports/embeddings-provider.js";
import { DEFAULT_CONFIDENCE_POLICY } from "../core/retrieval-confidence.js";
import { createOpenAIEmbeddings } from "../infrastructure/openai/openai-embeddings.js";
import { checkBaseline, parseBaseline } from "../eval/baseline.js";
import { buildCalibrationReport } from "../eval/calibrate.js";
import { CachingEmbeddings } from "../eval/caching-embeddings.js";
import { compareConfigs, parseComparison } from "../eval/compare.js";
import type { ComparisonResult, EvalSettings } from "../eval/compare.js";
import { describeDataset, parseDatasetFile } from "../eval/dataset.js";
import { buildEvalExport } from "../eval/export.js";
import type { EvalRunInfo } from "../eval/export.js";
import { loadCorpus } from "../eval/harness.js";
import { LexiconEmbeddings } from "../eval/lexicon-embeddings.js";
import { formatLivePlan, planLiveRun } from "../eval/live-plan.js";
import { formatBaselineResult, formatCalibration, formatComparison, formatEvalReport, formatRankingMatrix } from "../eval/report.js";
import { EVAL_USAGE, parseEvalArgs } from "./eval-cli.js";

const read = (file: string) => fs.readFileSync(file, "utf-8");

/** Calibration keeps at least this share of the answerable questions: refusing valid questions is the costlier mistake. */
const CALIBRATION_MIN_RECALL = 0.9;

function createEmbeddings(live: boolean, corpusDirectory: string, config: ReturnType<typeof loadToolConfig>): EmbeddingsProvider {
  if (live) {
    // The only place that needs a secret: the real model, for a real-quality measurement.
    return new CachingEmbeddings(
      createOpenAIEmbeddings({
        apiKey: openAiConfig.load(),
        model: config.openai.embeddingsModel,
        timeoutMs: config.openai.requestTimeoutMs,
      }),
    );
  }
  const lexicon = JSON.parse(read(path.join(path.dirname(corpusDirectory), "embedding-lexicon.json"))) as {
    concepts: Record<string, string[]>;
  };
  return new CachingEmbeddings(new LexiconEmbeddings(lexicon.concepts));
}

/** Where a result came from, for the report header and the JSON export. */
function runInfo(result: ComparisonResult, input: { datasetFile: string; version: number; description?: string; cases: Parameters<typeof describeDataset>[0]; embeddings: EmbeddingsProvider; live: boolean }): EvalRunInfo {
  return {
    embeddings: { model: input.embeddings.model, live: input.live },
    dataset: {
      version: input.version,
      description: input.description,
      file: input.datasetFile.replace(/\\/g, "/"),
      documents: result.documentCount,
      ...describeDataset(input.cases),
    },
    index: { fingerprint: result.fingerprint, profile: result.profile, chunks: result.chunkCount },
  };
}

/**
 * `npm run eval:retrieval` / `npm run eval:confidence`. Needs neither TELEGRAM_BOT_TOKEN nor an OpenAI key
 * (except for a confirmed --live run, which needs OPENAI_API_KEY and nothing else).
 * Exit code: 1 for bad input, a refused live run, or when --baseline finds a regression.
 */
export async function main(argv: string[]): Promise<number> {
  const command = parseEvalArgs(argv);
  if (command.kind === "help") {
    console.log(EVAL_USAGE);
    return 0;
  }
  if (command.kind === "error") {
    console.error(`${command.message}\n\n${EVAL_USAGE}`);
    return 1;
  }

  const config = loadToolConfig();
  const corpus = loadCorpus(command.corpus);
  const dataset = parseDatasetFile(read(command.dataset));
  const cases = command.limit ? dataset.cases.slice(0, command.limit) : dataset.cases;

  // A baseline pins its own configuration, so the check never depends on the environment.
  const baseline = command.baseline ? parseBaseline(read(command.baseline)) : undefined;
  const { confidence: policyOverride, ...numericOverrides } = command.overrides;
  const base: EvalSettings = baseline?.config ?? { ...config.chunking, ...config.retrieval, ...numericOverrides };
  if (policyOverride && !baseline) {
    base.confidence = { ...(base.confidence ?? DEFAULT_CONFIDENCE_POLICY), ...policyOverride };
  }

  if (command.live) {
    const plan = formatLivePlan(
      planLiveRun({ corpus, cases, chunking: { chunkSize: base.chunkSize, chunkOverlap: base.chunkOverlap } }),
      config.openai.embeddingsModel,
    );
    if (command.dryRun) {
      console.log(`${plan}\n\nDry run: nothing was sent.`);
      return 0;
    }
    if (!command.confirmSpend) {
      console.error(`${plan}\n\nNot started. Add --confirm-spend to run it (or --dry-run to only see this plan).`);
      return 1;
    }
    console.error(plan);
  }

  const embeddings = createEmbeddings(command.live, command.corpus, config);
  const configs = command.compare ? parseComparison(read(command.compare)) : [{ name: baseline ? "baseline" : "configured" }];
  const results = await compareConfigs({ corpus, cases, embeddings, base, configs });

  const info = (result: ComparisonResult) =>
    runInfo(result, { datasetFile: command.dataset, version: dataset.version, description: dataset.description, cases, embeddings, live: command.live });
  const embedder = command.live
    ? `${embeddings.model} (live OpenAI embeddings)`
    : `${embeddings.model} (offline, deterministic: validates the pipeline, not OpenAI embedding quality)`;
  const subset = command.limit && command.limit < dataset.cases.length ? `\nUsing the first ${cases.length} of ${dataset.cases.length} questions (--limit): metrics describe this subset only.` : "";

  if (baseline) {
    const verdict = checkBaseline(results[0].report, baseline);
    console.log(
      command.json
        ? JSON.stringify({ ...verdict, result: buildEvalExport(results[0].report, info(results[0])) }, null, 2)
        : `Embeddings: ${embedder}

${formatBaselineResult(verdict)}`,
    );
    return verdict.passed ? 0 : 1;
  }

  if (command.calibrate) {
    const [first] = results;
    const calibration = buildCalibrationReport(
      first.report.cases.map((item) => ({ id: item.id, answerable: item.answerable, split: item.split, signals: item.signals })),
      first.report.policy,
      { minRecall: CALIBRATION_MIN_RECALL },
    );
    console.log(
      command.json
        ? JSON.stringify({ embeddings: info(first).embeddings, dataset: info(first).dataset, index: info(first).index, calibration }, null, 2)
        : `Embeddings: ${embedder}${subset}\n\n${formatCalibration(calibration, info(first))}`,
    );
    return 0;
  }

  if (command.json) {
    const exported = results.map((result) => ({ name: result.name, ...buildEvalExport(result.report, info(result)) }));
    console.log(JSON.stringify(command.compare ? exported : exported[0], null, 2));
    return 0;
  }

  const body = command.compare
    ? [formatComparison(results), formatRankingMatrix(results, "calibration"), formatRankingMatrix(results, "validation"), formatRankingMatrix(results, "all")].join("\n\n")
    : formatEvalReport(results[0].report, { verbose: command.verbose, info: info(results[0]) });
  console.log(`Embeddings: ${embedder}
Corpus: ${results[0].chunkCount} chunks, ${cases.length} questions${subset}

${body}`);
  return 0;
}
