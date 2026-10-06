import { z } from "zod";
import type { AnswerabilityMetrics } from "./answerability.js";
import type { EvalReport, TagMetrics } from "./runner.js";

const metric = z.number().min(0).max(1);

const baselineSchema = z.object({
  description: z.string().optional(),
  /** The configuration the minimums were measured with. Pinned, so the check does not depend on the environment. */
  config: z.object({
    chunkSize: z.number().int().positive(),
    chunkOverlap: z.number().int().nonnegative(),
    topK: z.number().int().positive(),
    minScore: z.number().min(-1).max(1),
    semanticLimit: z.number().int().nonnegative(),
    lexicalLimit: z.number().int().nonnegative(),
    rrfK: z.number().positive(),
    contextMaxChars: z.number().int().positive(),
    semanticWeight: z.number().min(0).optional(),
    lexicalWeight: z.number().min(0).optional(),
    exactTokenBonus: z.number().min(0).optional(),
    confidence: z
      .object({
        minSemanticScore: z.number().min(-1).max(1),
        minTermCoverage: z.number().min(0).max(1),
        requireKnownIdentifiers: z.boolean(),
      })
      .optional(),
  }),
  /**
   * Metric name -> lowest acceptable value: recallAtK, hitRateAtK, candidateRecallAtK, mrr, candidateMrr, termCoverage,
   * and of the confidence gate answerabilityRecall, answerabilitySpecificity, answerabilityPrecision;
   * "tag/metric" restricts a metric to one tag.
   */
  minimums: z.record(z.string(), metric),
  /** Absolute slack below a minimum before a check fails; absorbs rounding and the effect of one flipped case. */
  tolerance: z.number().min(0).max(0.2).default(0.02),
});

export type Baseline = z.infer<typeof baselineSchema>;

export function parseBaseline(json: string): Baseline {
  const parsed = baselineSchema.safeParse(JSON.parse(json));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "baseline"}: ${issue.message}`);
    throw new Error(`Invalid baseline: ${problems.join("; ")}`);
  }
  return parsed.data;
}

type BaselineCheck = { metric: string; actual: number; minimum: number; ok: boolean };

export type BaselineResult = {
  passed: boolean;
  checks: BaselineCheck[];
  /** Any value above zero fails the check regardless of quality. */
  isolationViolations: number;
};

const AT_K = /^(recall|hitRate|candidateRecall)At(\d+)$/;

/** "mrr" is a metric of the whole run; "paraphrase/recallAt3" is the same metric restricted to one tag. */
function valueOf(report: EvalReport, name: string): number {
  const slash = name.indexOf("/");
  if (slash <= 0) {
    return valueOfAggregate(report, report.overall, name);
  }

  const tag = name.slice(0, slash);
  const metrics = report.byTag[tag];
  if (!metrics) {
    throw new Error(`The baseline refers to tag "${tag}", which has no questions in this run.`);
  }
  return valueOfAggregate(report, metrics, name.slice(slash + 1));
}

const GATE_METRICS: Record<string, keyof AnswerabilityMetrics> = {
  answerabilityRecall: "recall",
  answerabilitySpecificity: "specificity",
  answerabilityPrecision: "precision",
};

function valueOfAggregate(report: EvalReport, overall: EvalReport["overall"] | TagMetrics, name: string): number {
  const gateMetric = GATE_METRICS[name];
  if (gateMetric) {
    const gate = overall === report.overall ? report.answerability : (overall as TagMetrics).answerability;
    const value = gate[gateMetric];
    if (typeof value !== "number") {
      throw new Error(`The baseline asks for ${name}, but this run has no questions of the kind it is computed from (no value).`);
    }
    return value;
  }
  if (name === "mrr") return overall.mrr;
  if (name === "candidateMrr") return overall.candidateMrr;
  if (name === "termCoverage" && overall === report.overall) return report.termCoverage;

  const match = AT_K.exec(name);
  if (match) {
    const k = Number(match[2]);
    const table = { recall: overall.recallAt, hitRate: overall.hitRateAt, candidateRecall: overall.candidateRecallAt }[
      match[1] as "recall" | "hitRate" | "candidateRecall"
    ];
    if (table[k] !== undefined) {
      return table[k];
    }
    throw new Error(`The baseline asks for ${name}, but the report only has K = ${report.ks.join(", ")}.`);
  }
  throw new Error(`Unknown baseline metric "${name}".`);
}

/**
 * Compares a report with the committed minimums. A metric fails when it is more than `tolerance` below its
 * minimum; any cross-user leak fails the whole check. Improvements never fail - raise the minimums
 * deliberately (in review) when quality has really gone up.
 */
export function checkBaseline(report: EvalReport, baseline: Baseline): BaselineResult {
  const checks = Object.entries(baseline.minimums).map(([name, minimum]): BaselineCheck => {
    const actual = valueOf(report, name);
    // The small epsilon keeps 0.85 - 0.02 from failing a measured 0.83 because of floating point arithmetic.
    return { metric: name, actual, minimum, ok: actual >= minimum - baseline.tolerance - 1e-9 };
  });

  return {
    passed: checks.every((check) => check.ok) && report.isolationViolations === 0,
    checks,
    isolationViolations: report.isolationViolations,
  };
}
