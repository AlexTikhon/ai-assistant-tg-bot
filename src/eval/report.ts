import type { BaselineResult } from "./baseline.js";
import type { ComparisonResult, EvalSettings } from "./compare.js";
import type { AggregateMetrics } from "./metrics.js";
import type { CaseResult, EvalReport, RetrievedItem } from "./runner.js";

const fixed = (value: number) => value.toFixed(2);

function signed(delta: number) {
  const rounded = Math.round(delta * 100) / 100;
  return rounded === 0 ? "±0.00" : `${rounded > 0 ? "+" : "-"}${Math.abs(rounded).toFixed(2)}`;
}

const rank = (label: string, value: number | undefined) => (value === undefined ? undefined : `${label} #${value}`);

function describeRanks(item: RetrievedItem) {
  return [rank("semantic", item.semanticRank), rank("lexical", item.lexicalRank), rank("rrf", item.fusedRank)]
    .filter(Boolean)
    .join(" · ");
}

function expectedText(result: CaseResult) {
  return result.expectedSources
    .map((source) => (source.contains ? `${source.document} ("${source.contains}")` : `${source.document} (chunk ${source.chunkHint})`))
    .join(", ");
}

function formatCase(result: CaseResult, verbose: boolean) {
  const header = (verdict: string, extra: string) => `${verdict.padEnd(5)} ${result.id}  ${extra}`;

  if (!result.answerable) {
    return [
      header("-", `no answer expected; context returned: ${result.retrieved.length} chunk(s)`),
      `      ${result.question}`,
      ...(verbose ? formatRetrieved(result) : []),
    ];
  }

  const found = result.firstRelevant;
  let location: string;
  if (found?.inContext) {
    location = `found at context rank ${found.rank} · ${describeRanks(found)}`;
  } else if (found) {
    location = `not in context (candidate rrf #${found.fusedRank}${found.semanticRank ? `, semantic #${found.semanticRank}` : ""}${found.lexicalRank ? `, lexical #${found.lexicalRank}` : ""})`;
  } else {
    location = "not retrieved";
  }

  return [
    header(result.hit ? "HIT" : "MISS", `rr ${fixed(result.reciprocalRank)}  [${result.tags.join(", ")}]`),
    `      ${result.question}`,
    `      expected: ${expectedText(result)}`,
    `      ${location}`,
    ...(verbose ? formatRetrieved(result) : []),
  ];
}

function formatRetrieved(result: CaseResult) {
  return result.retrieved.map(
    (item) => `        ${item.rank}. ${item.document} #${item.chunkIndex + 1} ${item.relevant ? "*" : " "} ${describeRanks(item)}`,
  );
}

function metricRows(metrics: AggregateMetrics, ks: readonly number[]) {
  return [
    ...ks.map((k) => `  ${`Recall@${k}`.padEnd(12)} ${fixed(metrics.recallAt[k])}`),
    ...ks.map((k) => `  ${`HitRate@${k}`.padEnd(12)} ${fixed(metrics.hitRateAt[k])}`),
    `  ${"MRR".padEnd(12)} ${fixed(metrics.mrr)}`,
  ];
}

export const formatSettings = (settings: EvalSettings | EvalReport["settings"]) =>
  Object.entries(settings)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

/** Human-readable evaluation report: aggregates, per-tag results and one block per question. */
export function formatEvalReport(report: EvalReport, options: { verbose: boolean }) {
  const { overall, ks } = report;
  const lines = [
    "Retrieval evaluation",
    `Settings: ${formatSettings(report.settings)}`,
    "",
    `Answerable questions: ${overall.cases}`,
    ...metricRows(overall, ks),
    "",
    `Before context selection: Recall@${ks[ks.length - 1]} ${fixed(overall.candidateRecallAt[ks[ks.length - 1]])}, MRR ${fixed(overall.candidateMrr)}` +
      ` (${overall.lostToSelection} question(s) had an expected source ranked but kept out of the context)`,
    `Expected-term coverage in the context: ${fixed(report.termCoverage)}`,
    `No-answer questions: ${report.noAnswer.cases} (${report.noAnswer.withContext} still returned context)`,
    `Isolation violations: ${report.isolationViolations}`,
    "",
    "By tag:",
    `  ${"tag".padEnd(16)} ${"cases".padStart(5)} ${ks.map((k) => `R@${k}`.padStart(5)).join(" ")} ${"MRR".padStart(5)}`,
    ...Object.entries(report.byTag)
      .filter(([, metrics]) => metrics.cases > 0)
      .map(
        ([tag, metrics]) =>
          `  ${tag.padEnd(16)} ${String(metrics.cases).padStart(5)} ${ks.map((k) => fixed(metrics.recallAt[k]).padStart(5)).join(" ")} ${fixed(metrics.mrr).padStart(5)}`,
      ),
    "",
    "Per question:",
    ...report.cases.flatMap((result) => formatCase(result, options.verbose)),
  ];
  return lines.join("\n");
}

/** Side-by-side configurations in the order given; changes are shown against the first one. */
export function formatComparison(results: readonly ComparisonResult[]) {
  const first = results[0];
  const delta = (value: number, reference: number | undefined, isFirst: boolean) =>
    isFirst || reference === undefined ? fixed(value) : `${fixed(value)} (${signed(value - reference)})`;

  const blocks = results.map((result, index) => {
    const { overall } = result.report;
    const reference = first.report.overall;
    const isFirst = index === 0;
    return [
      `Configuration ${result.name}`,
      formatSettings(result.settings),
      `Recall@1: ${delta(overall.recallAt[1], reference.recallAt[1], isFirst)}`,
      `Recall@3: ${delta(overall.recallAt[3], reference.recallAt[3], isFirst)}`,
      `Recall@5: ${delta(overall.recallAt[5], reference.recallAt[5], isFirst)}`,
      `MRR:      ${delta(overall.mrr, reference.mrr, isFirst)}`,
      `(chunks ${result.chunkCount}, no-answer with context ${result.report.noAnswer.withContext}/${result.report.noAnswer.cases}, isolation violations ${result.report.isolationViolations})`,
    ].join("\n");
  });

  const width = Math.max(...results.map((result) => result.name.length), 4);
  const table = [
    "Summary (changes against the first configuration)",
    `${"name".padEnd(width)}  R@1   R@3   R@5   MRR`,
    ...results.map((result) => {
      const { overall } = result.report;
      return `${result.name.padEnd(width)}  ${[overall.recallAt[1], overall.recallAt[3], overall.recallAt[5], overall.mrr].map(fixed).join("  ")}`;
    }),
  ].join("\n");

  return `${blocks.join("\n\n")}\n\n${table}`;
}

export function formatBaselineResult(result: BaselineResult) {
  const lines = [
    "Baseline check",
    ...result.checks.map(
      (check) => `${check.ok ? "ok  " : "FAIL"} ${check.metric.padEnd(14)} ${fixed(check.actual)} (minimum ${fixed(check.minimum)})`,
    ),
  ];
  if (result.isolationViolations > 0) {
    lines.push(`FAIL isolation: ${result.isolationViolations} chunk(s) of another user were retrieved`);
  }
  lines.push(result.passed ? "Retrieval quality meets the baseline." : "Retrieval quality is below the baseline.");
  return lines.join("\n");
}
