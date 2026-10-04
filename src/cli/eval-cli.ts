import { parseArgs } from "node:util";
import type { EvalSettings } from "../eval/compare.js";

export const EVAL_USAGE = `Offline retrieval evaluation: asks the questions of a dataset through the real retrieval pipeline
(FTS5, vector scan, RRF, de-duplication, context selection) and reports Recall@K, HitRate@K and MRR.

Usage: npm run eval:retrieval -- [options]

  --dataset <file>         JSONL questions with expected sources   (default eval/datasets/retrieval.jsonl)
  --corpus <dir>           documents per owner: <dir>/<user>/<file> (default eval/corpus)
  --verbose                also list the retrieved chunks of every question
  --json                   print the result as JSON
  --compare <file>         run several configurations (see eval/comparisons/default.json) and compare them
  --baseline <file>        check the result against minimum metrics (npm run test:retrieval); exit code 1 on failure
  --live                   embed with the real OpenAI model instead of the offline embedder (needs OPENAI_API_KEY)

Settings (default: the configuration from the environment, i.e. what the bot would use):
  --top-k <n>  --semantic-limit <n>  --lexical-limit <n>  --rrf-k <n>  --min-score <x>  --context-chars <n>
  --chunk-size <n>  --chunk-overlap <n>

Nothing here changes your configuration or your database. No Telegram token is needed.`;

export type EvalCommand =
  | {
      kind: "run";
      dataset: string;
      corpus: string;
      verbose: boolean;
      json: boolean;
      live: boolean;
      compare?: string;
      baseline?: string;
      overrides: Partial<EvalSettings>;
    }
  | { kind: "help" }
  | { kind: "error"; message: string };

const NUMERIC: Array<[option: string, setting: keyof EvalSettings, check: (value: number) => boolean, expectation: string]> = [
  ["top-k", "topK", (v) => Number.isInteger(v) && v >= 1, "a positive integer"],
  ["semantic-limit", "semanticLimit", (v) => Number.isInteger(v) && v >= 0, "an integer >= 0"],
  ["lexical-limit", "lexicalLimit", (v) => Number.isInteger(v) && v >= 0, "an integer >= 0"],
  ["rrf-k", "rrfK", (v) => v > 0, "a positive number"],
  ["min-score", "minScore", (v) => v >= -1 && v <= 1, "a number between -1 and 1"],
  ["context-chars", "contextMaxChars", (v) => Number.isInteger(v) && v >= 1, "a positive integer"],
  ["chunk-size", "chunkSize", (v) => Number.isInteger(v) && v >= 1, "a positive integer"],
  ["chunk-overlap", "chunkOverlap", (v) => Number.isInteger(v) && v >= 0, "an integer >= 0"],
];

/** Parses `npm run eval:retrieval -- ...`. Pure: never exits or prints. */
export function parseEvalArgs(argv: string[]): EvalCommand {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dataset: { type: "string" },
        corpus: { type: "string" },
        verbose: { type: "boolean" },
        json: { type: "boolean" },
        compare: { type: "string" },
        baseline: { type: "string" },
        live: { type: "boolean" },
        help: { type: "boolean" },
        ...Object.fromEntries(NUMERIC.map(([option]) => [option, { type: "string" as const }])),
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }

  if (values.help) {
    return { kind: "help" };
  }

  const overrides: Partial<EvalSettings> = {};
  for (const [option, setting, check, expectation] of NUMERIC) {
    const raw = values[option as keyof typeof values] as string | undefined;
    if (raw === undefined) continue;
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value) || !check(value)) {
      return { kind: "error", message: `--${option} must be ${expectation} (got "${raw}").` };
    }
    overrides[setting] = value;
  }

  if (values.compare && values.baseline) {
    return { kind: "error", message: "--compare and --baseline cannot be used together." };
  }
  if (values.live && values.baseline) {
    return {
      kind: "error",
      message: "--baseline only applies to the offline embedder: its minimums were measured with it. Drop --live.",
    };
  }

  return {
    kind: "run",
    dataset: values.dataset ?? "eval/datasets/retrieval.jsonl",
    corpus: values.corpus ?? "eval/corpus",
    verbose: values.verbose ?? false,
    json: values.json ?? false,
    live: values.live ?? false,
    compare: values.compare,
    baseline: values.baseline,
    overrides,
  };
}
