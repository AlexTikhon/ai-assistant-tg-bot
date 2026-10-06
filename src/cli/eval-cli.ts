import { describeErrorSafely } from "../shared/scrub.js";
import { parseArgs } from "node:util";
import type { ConfidencePolicy } from "../core/retrieval-confidence.js";
import type { EvalSettings } from "../eval/compare.js";

export const EVAL_USAGE = `Offline retrieval evaluation: asks the questions of a dataset through the real retrieval pipeline
(FTS5, vector scan, RRF, exact-token bonus, de-duplication, context selection) and reports Recall@K, HitRate@K, MRR
and how the answerability gate treats answerable and unanswerable questions.

Usage: npm run eval:retrieval -- [options]     (npm run eval:confidence calibrates the gate)

  --dataset <file>         JSONL questions with expected sources   (default eval/datasets/retrieval.jsonl)
  --corpus <dir>           documents per owner: <dir>/<user>/<file> (default eval/corpus)
  --verbose                also list the evidence and the retrieved chunks of every question
  --json                   print the machine-readable result (see docs/evaluation.md)
  --compare <file>         run several configurations (e.g. eval/comparisons/ranking.json) and compare them
  --baseline <file>        check the result against minimum metrics (npm run test:retrieval); exit code 1 on failure
  --calibrate              sweep the confidence policy on the calibration split, then report validation separately
  --limit <n>              use only the first n questions of the dataset

  --live                   embed with the real OpenAI model instead of the offline embedder. COSTS MONEY.
  --dry-run                with --live: only print how many API requests would be made, then stop (no key needed)
  --confirm-spend          with --live: actually start. Without it --live only prints the plan and stops.

Settings (default: the configuration from the environment, i.e. what the bot would use):
  --top-k <n>  --semantic-limit <n>  --lexical-limit <n>  --rrf-k <n>  --min-score <x>  --context-chars <n>
  --chunk-size <n>  --chunk-overlap <n>
  --semantic-weight <x>  --lexical-weight <x>  --exact-token-bonus <x>
  --min-semantic-score <x>  --min-term-coverage <x>

Nothing here changes your configuration or your database (the index lives in memory). No Telegram token is
needed; --live needs OPENAI_API_KEY and nothing else.`;

export type EvalCommand =
  | {
      kind: "run";
      dataset: string;
      corpus: string;
      verbose: boolean;
      json: boolean;
      live: boolean;
      calibrate: boolean;
      dryRun: boolean;
      confirmSpend: boolean;
      limit?: number;
      compare?: string;
      baseline?: string;
      overrides: Partial<Omit<EvalSettings, "confidence">> & { confidence?: Partial<ConfidencePolicy> };
    }
  | { kind: "help" }
  | { kind: "error"; message: string };

type NumericSetting = Exclude<keyof EvalSettings, "confidence">;

const NUMERIC: Array<[option: string, setting: NumericSetting, check: (value: number) => boolean, expectation: string]> = [
  ["top-k", "topK", (v) => Number.isInteger(v) && v >= 1, "a positive integer"],
  ["semantic-limit", "semanticLimit", (v) => Number.isInteger(v) && v >= 0, "an integer >= 0"],
  ["lexical-limit", "lexicalLimit", (v) => Number.isInteger(v) && v >= 0, "an integer >= 0"],
  ["rrf-k", "rrfK", (v) => v > 0, "a positive number"],
  ["min-score", "minScore", (v) => v >= -1 && v <= 1, "a number between -1 and 1"],
  ["context-chars", "contextMaxChars", (v) => Number.isInteger(v) && v >= 1, "a positive integer"],
  ["chunk-size", "chunkSize", (v) => Number.isInteger(v) && v >= 1, "a positive integer"],
  ["chunk-overlap", "chunkOverlap", (v) => Number.isInteger(v) && v >= 0, "an integer >= 0"],
  ["semantic-weight", "semanticWeight", (v) => v >= 0, "a number >= 0"],
  ["lexical-weight", "lexicalWeight", (v) => v >= 0, "a number >= 0"],
  ["exact-token-bonus", "exactTokenBonus", (v) => v >= 0, "a number >= 0"],
];

const POLICY: Array<[option: string, field: "minSemanticScore" | "minTermCoverage", check: (value: number) => boolean, expectation: string]> = [
  ["min-semantic-score", "minSemanticScore", (v) => v >= -1 && v <= 1, "a number between -1 and 1"],
  ["min-term-coverage", "minTermCoverage", (v) => v >= 0 && v <= 1, "a number between 0 and 1"],
];

function parseNumber(raw: string) {
  const value = Number(raw);
  return raw.trim() === "" || !Number.isFinite(value) ? undefined : value;
}

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
        calibrate: { type: "boolean" },
        "dry-run": { type: "boolean" },
        "confirm-spend": { type: "boolean" },
        limit: { type: "string" },
        help: { type: "boolean" },
        ...Object.fromEntries([...NUMERIC, ...POLICY].map(([option]) => [option, { type: "string" as const }])),
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { kind: "error", message: describeErrorSafely(error) };
  }

  if (values.help) {
    return { kind: "help" };
  }

  const overrides: Extract<EvalCommand, { kind: "run" }>["overrides"] = {};
  for (const [option, setting, check, expectation] of NUMERIC) {
    const raw = values[option as keyof typeof values] as string | undefined;
    if (raw === undefined) continue;
    const value = parseNumber(raw);
    if (value === undefined || !check(value)) {
      return { kind: "error", message: `--${option} must be ${expectation} (got "${raw}").` };
    }
    overrides[setting] = value;
  }
  for (const [option, field, check, expectation] of POLICY) {
    const raw = values[option as keyof typeof values] as string | undefined;
    if (raw === undefined) continue;
    const value = parseNumber(raw);
    if (value === undefined || !check(value)) {
      return { kind: "error", message: `--${option} must be ${expectation} (got "${raw}").` };
    }
    overrides.confidence = { ...overrides.confidence, [field]: value };
  }

  let limit: number | undefined;
  if (values.limit !== undefined) {
    limit = parseNumber(values.limit);
    if (limit === undefined || !Number.isInteger(limit) || limit < 1) {
      return { kind: "error", message: `--limit must be a positive integer (got "${values.limit}").` };
    }
  }

  if (values.compare && values.baseline) {
    return { kind: "error", message: "--compare and --baseline cannot be used together." };
  }
  if (values.calibrate && (values.compare || values.baseline)) {
    return { kind: "error", message: "--calibrate cannot be combined with --compare or --baseline." };
  }
  if (values.live && values.baseline) {
    return {
      kind: "error",
      message: "--baseline only applies to the offline embedder: its minimums were measured with it. Drop --live.",
    };
  }
  if (values["dry-run"] && !values.live) {
    return { kind: "error", message: "--dry-run only makes sense with --live (the offline evaluation costs nothing)." };
  }
  if (values["confirm-spend"] && !values.live) {
    return { kind: "error", message: "--confirm-spend only makes sense with --live (nothing is spent otherwise)." };
  }

  return {
    kind: "run",
    dataset: values.dataset ?? "eval/datasets/retrieval.jsonl",
    corpus: values.corpus ?? "eval/corpus",
    verbose: values.verbose ?? false,
    json: values.json ?? false,
    live: values.live ?? false,
    calibrate: values.calibrate ?? false,
    dryRun: values["dry-run"] ?? false,
    confirmSpend: values["confirm-spend"] ?? false,
    limit,
    compare: values.compare,
    baseline: values.baseline,
    overrides,
  };
}
