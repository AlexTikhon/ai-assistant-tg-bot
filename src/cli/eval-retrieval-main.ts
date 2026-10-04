import fs from "node:fs";
import path from "node:path";
import { loadToolConfig, openAiConfig } from "../config/config.js";
import type { EmbeddingsProvider } from "../application/ports/embeddings-provider.js";
import { createOpenAIEmbeddings } from "../infrastructure/openai/openai-embeddings.js";
import { checkBaseline, parseBaseline } from "../eval/baseline.js";
import { CachingEmbeddings } from "../eval/caching-embeddings.js";
import { compareConfigs, parseComparison } from "../eval/compare.js";
import type { ComparisonResult, EvalSettings } from "../eval/compare.js";
import { parseDataset } from "../eval/dataset.js";
import { loadCorpus } from "../eval/harness.js";
import { LexiconEmbeddings } from "../eval/lexicon-embeddings.js";
import { formatBaselineResult, formatComparison, formatEvalReport } from "../eval/report.js";
import { EVAL_USAGE, parseEvalArgs } from "./eval-cli.js";

const read = (file: string) => fs.readFileSync(file, "utf-8");

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

/**
 * `npm run eval:retrieval`. Needs neither TELEGRAM_BOT_TOKEN nor an OpenAI key (except with --live).
 * Exit code: 1 for bad input, or when --baseline finds a regression.
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
  const cases = parseDataset(read(command.dataset));
  const embeddings = createEmbeddings(command.live, command.corpus, config);

  // A baseline pins its own configuration, so the check never depends on the environment.
  const baseline = command.baseline ? parseBaseline(read(command.baseline)) : undefined;
  const base: EvalSettings = baseline?.config ?? { ...config.chunking, ...config.retrieval, ...command.overrides };

  const configs = command.compare ? parseComparison(read(command.compare)) : [{ name: baseline ? "baseline" : "configured" }];
  const results = await compareConfigs({ corpus, cases, embeddings, base, configs });

  const embedder = command.live
    ? `${embeddings.model} (live OpenAI embeddings)`
    : `${embeddings.model} (offline, deterministic: validates the pipeline, not OpenAI embedding quality)`;

  if (baseline) {
    const verdict = checkBaseline(results[0].report, baseline);
    console.log(
      command.json
        ? JSON.stringify({ ...verdict, report: results[0].report }, null, 2)
        : `Embeddings: ${embedder}

${formatBaselineResult(verdict)}`,
    );
    return verdict.passed ? 0 : 1;
  }

  if (command.json) {
    console.log(JSON.stringify(results.length === 1 ? results[0].report : results, null, 2));
  } else {
    const body = command.compare ? formatComparison(results) : formatEvalReport(results[0].report, { verbose: command.verbose });
    console.log(`Embeddings: ${embedder}
Corpus: ${results[0].chunkCount} chunks, ${cases.length} questions

${body}`);
  }
  return 0;
}
