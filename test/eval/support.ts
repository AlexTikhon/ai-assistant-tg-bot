import path from "node:path";
import { answerabilityMetrics, summarizeSignals } from "../../src/eval/answerability.js";
import type { aggregateCases } from "../../src/eval/metrics.js";
import { fileURLToPath } from "node:url";

/** The repository root, independent of the directory the tests are started from. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Zeroed answerability results, for tests that build an EvalReport by hand. */
export const emptyAnswerability = answerabilityMetrics({ tp: 0, fn: 0, fp: 0, tn: 0 });
export const emptySignalSummary = summarizeSignals([]);
export const emptySplits = (retrieval: ReturnType<typeof aggregateCases>) => ({
  calibration: { queries: 0, retrieval, answerability: emptyAnswerability },
  validation: { queries: 0, retrieval, answerability: emptyAnswerability },
});
