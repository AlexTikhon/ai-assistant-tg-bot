import type { AnswerabilityMetrics, SignalSummary } from "./answerability.js";
import type { CalibrationReport, PolicyEvaluation, SweepResult } from "./calibrate.js";
import type { BaselineResult } from "./baseline.js";
import type { ComparisonResult, EvalSettings } from "./compare.js";
import type { EvalRunInfo } from "./export.js";
import type { AggregateMetrics } from "./metrics.js";
import type { CaseResult, EvalReport, RetrievedItem } from "./runner.js";

const fixed = (value: number) => value.toFixed(2);
/** A value that may be missing (no cases behind it): "n/a" instead of NaN. */
const orNa = (value: number | null | undefined, digits = 2) => (value === null || value === undefined ? "n/a" : value.toFixed(digits));
const percent = (value: number | null) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);

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

/** What the gate decided, and the two numbers that most often explain why. */
function gateLine(result: CaseResult) {
  const { signals } = result;
  const parts = [
    `gate: ${result.decision} (${result.reason})`,
    signals.topSemanticScore === null ? undefined : `semantic ${fixed(signals.topSemanticScore)}`,
    `coverage ${fixed(signals.bestTermCoverage)}`,
    signals.exactTargets > 0 ? `exact ${signals.exactTargetsFound}/${signals.exactTargets}` : undefined,
  ];
  return `      ${parts.filter(Boolean).join(" · ")}`;
}

/** The evidence behind one decision, for `--verbose`. */
function signalLines(result: CaseResult) {
  const { signals } = result;
  return [
    "      evidence:",
    `        top semantic score: ${orNa(signals.topSemanticScore).replace("n/a", "-")}${signals.semanticGap === null ? "" : ` (gap ${fixed(signals.semanticGap)})`}`,
    `        lexical matches: ${signals.lexicalCount}${signals.topLexicalScore === null ? "" : ` (top score ${fixed(signals.topLexicalScore)})`}`,
    `        top RRF score: ${signals.topFusedScore === null ? "-" : signals.topFusedScore.toFixed(4)}${signals.fusedGap === null ? "" : ` (gap ${signals.fusedGap.toFixed(4)})`}`,
    `        dual-method candidates: ${signals.dualMethodCount}`,
    `        exact targets: ${signals.exactTargets} asked, ${signals.exactTargetsFound} found${signals.bestExactRank === null ? "" : ` (best at rank ${signals.bestExactRank})`}`,
    `        term coverage: ${fixed(signals.bestTermCoverage)}`,
    `        expected source rank: ${result.expectedSourceRank ?? "-"}`,
  ];
}

function formatCase(result: CaseResult, verbose: boolean) {
  const header = (verdict: string, extra: string) => `${verdict.padEnd(5)} ${result.id}  ${extra}`;
  const diagnostics = [gateLine(result), ...(verbose ? signalLines(result) : [])];

  if (!result.answerable) {
    return [
      header("-", `no answer expected; context returned: ${result.retrieved.length} chunk(s)`),
      `      ${result.question}`,
      ...diagnostics,
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
    ...diagnostics,
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
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) =>
      key === "confidence" && typeof value === "object" && value !== null
        ? Object.entries(value).map(([name, inner]) => `${name}=${inner}`)
        : [`${key}=${value}`],
    )
    .join(" ");

const count = (matrix: AnswerabilityMetrics) => `TP ${matrix.tp}  FN ${matrix.fn}  FP ${matrix.fp}  TN ${matrix.tn}`;

function answerabilityRows(metrics: AnswerabilityMetrics) {
  const row = (label: string, value: number | null, note: string) => `  ${label.padEnd(20)} ${orNa(value)}   ${note}`;
  return [
    `  ${count(metrics)}`,
    row("precision", metrics.precision, "of the questions let through, the share that were answerable"),
    row("recall", metrics.recall, "of the answerable questions, the share let through"),
    row("specificity", metrics.specificity, "of the unanswerable questions, the share refused"),
    row("false-positive rate", metrics.falsePositiveRate, "unanswerable questions that reached the model"),
    row("false-negative rate", metrics.falseNegativeRate, "answerable questions that were refused"),
  ];
}

function evidenceTable(answerable: SignalSummary, unanswerable: SignalSummary) {
  const row = (label: string, a: string, b: string) => `  ${label.padEnd(28)} ${a.padStart(10)} ${b.padStart(13)}`;
  return [
    row("", "answerable", "unanswerable"),
    row("questions", String(answerable.cases), String(unanswerable.cases)),
    row("median top semantic score", orNa(answerable.medianTopSemanticScore), orNa(unanswerable.medianTopSemanticScore)),
    row("median top RRF score", orNa(answerable.medianTopFusedScore, 4), orNa(unanswerable.medianTopFusedScore, 4)),
    row("median term coverage", orNa(answerable.medianTermCoverage), orNa(unanswerable.medianTermCoverage)),
    row("with semantic hit", percent(answerable.withSemanticHit), percent(unanswerable.withSemanticHit)),
    row("with lexical hit", percent(answerable.withLexicalHit), percent(unanswerable.withLexicalHit)),
    row("with dual-method hit", percent(answerable.withDualMethodHit), percent(unanswerable.withDualMethodHit)),
    row("with exact-token hit", percent(answerable.withExactTokenHit), percent(unanswerable.withExactTokenHit)),
  ];
}

function runHeader(info: EvalRunInfo) {
  const { dataset } = info;
  const split = (name: "calibration" | "validation") => `${name} ${dataset.bySplit[name].queries}`;
  return [
    `Dataset: version ${dataset.version} · ${dataset.queries} queries (${dataset.answerable} answerable, ${dataset.unanswerable} unanswerable) · ${dataset.documents} documents · ${split("calibration")} / ${split("validation")}`,
    `Index fingerprint: ${info.index.fingerprint}`,
  ];
}

/** Human-readable evaluation report: aggregates, the answerability gate, per-tag results and one block per question. */
export function formatEvalReport(report: EvalReport, options: { verbose: boolean; info?: EvalRunInfo }) {
  const { overall, ks } = report;
  const tagRows = Object.entries(report.byTag).filter(([, metrics]) => metrics.queries > 0);

  const lines = [
    "Retrieval evaluation",
    ...(options.info ? runHeader(options.info) : []),
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
    `Answerability gate: ${formatSettings({ confidence: report.policy } as unknown as EvalReport["settings"])}`,
    "Positive = let through to the model. An unanswerable question let through is a false positive; an answerable one refused is a false negative.",
    ...answerabilityRows(report.answerability),
    "",
    ...(["calibration", "validation"] as const).flatMap((split) => [
      `${split === "calibration" ? "Calibration" : "Validation"} split (${report.bySplit[split].queries} queries)${split === "calibration" ? ": used to choose thresholds and ranking" : ": validation is only reported, never used to choose"}`,
      ...(report.bySplit[split].retrieval.cases > 0
        ? [`  retrieval: Recall@1 ${fixed(report.bySplit[split].retrieval.recallAt[1])}  Recall@${ks[ks.length - 1]} ${fixed(report.bySplit[split].retrieval.recallAt[ks[ks.length - 1]])}  MRR ${fixed(report.bySplit[split].retrieval.mrr)}`]
        : []),
      ...answerabilityRows(report.bySplit[split].answerability),
      "",
    ]),
    "Evidence by group:",
    ...evidenceTable(report.signals.answerable, report.signals.unanswerable),
    "",
    "By tag:",
    `  ${"tag".padEnd(18)} ${"cases".padStart(5)} ${ks.map((k) => `R@${k}`.padStart(5)).join(" ")} ${"MRR".padStart(5)}   gate`,
    ...tagRows.map(([tag, metrics]) => {
      const retrieval =
        metrics.cases > 0
          ? `${String(metrics.cases).padStart(5)} ${ks.map((k) => fixed(metrics.recallAt[k]).padStart(5)).join(" ")} ${fixed(metrics.mrr).padStart(5)}`
          : `${String(0).padStart(5)} ${ks.map(() => "-".padStart(5)).join(" ")} ${"-".padStart(5)}`;
      return `  ${tag.padEnd(18)} ${retrieval}   ${count(metrics.answerability)}`;
    }),
    "",
    "Per question:",
    ...report.cases.flatMap((result) => formatCase(result, options.verbose)),
  ];
  return lines.join("\n");
}

/** Tags worth a column in a configuration comparison. */
const COMPARISON_TAGS = ["semantic-only", "paraphrase", "exact-term", "error-code", "multi-document", "no-answer"];

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

/**
 * Ranking variants side by side, one split at a time: overall retrieval quality, the answerability error
 * rates of each variant's own report (same gate policy), and a per-tag breakdown, so that an overall gain
 * cannot hide a regression in a category.
 */
export function formatRankingMatrix(results: readonly ComparisonResult[], split: "calibration" | "validation" | "all") {
  const pick = (result: ComparisonResult) => {
    if (split === "all") {
      return { retrieval: result.report.overall, answerability: result.report.answerability };
    }
    return result.report.bySplit[split];
  };
  const width = Math.max(...results.map((result) => result.name.length), 7);
  const header = `${"variant".padEnd(width)}  R@1   R@3   R@5   MRR   FPR   FNR`;
  const rows = results.map((result) => {
    const { retrieval, answerability } = pick(result);
    return `${result.name.padEnd(width)}  ${[retrieval.recallAt[1], retrieval.recallAt[3], retrieval.recallAt[5], retrieval.mrr].map(fixed).join("  ")}  ${orNa(answerability.falsePositiveRate)}  ${orNa(answerability.falseNegativeRate)}`;
  });

  const byTag = COMPARISON_TAGS.filter((tag) => results.some((result) => result.report.byTag[tag]));
  const tagRows = byTag.map((tag) => {
    const cells = results.map((result) => {
      const metrics = result.report.byTag[tag];
      if (!metrics) return "-";
      const inSplit = split === "all" ? metrics : undefined;
      return metrics.cases > 0 && inSplit ? `${fixed(inSplit.recallAt[1])}/${fixed(inSplit.mrr)}` : `${metrics.queries}q`;
    });
    return `  ${tag.padEnd(16)} ${cells.map((cell) => cell.padStart(11)).join(" ")}`;
  });

  return [
    `Ranking variants - ${split} split`,
    header,
    ...rows,
    ...(split === "all" && tagRows.length > 0
      ? ["", `By tag (Recall@1/MRR), columns: ${results.map((result) => result.name).join(" | ")}`, ...tagRows]
      : []),
  ].join("\n");
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

function misclassified(evaluation: PolicyEvaluation) {
  const ids = (predicate: (outcome: PolicyEvaluation["outcomes"][number]) => boolean) =>
    evaluation.outcomes.filter(predicate).map((outcome) => outcome.id);
  const list = (values: string[]) => (values.length === 0 ? "none" : values.join(", "));
  return [
    `    wrongly refused (FN): ${list(ids((outcome) => outcome.answerable && outcome.decision === "abstain"))}`,
    `    wrongly let through (FP): ${list(ids((outcome) => !outcome.answerable && outcome.decision === "answer"))}`,
  ];
}

function policyText(policy: SweepResult["policy"]) {
  return `minSemanticScore=${policy.minSemanticScore} minTermCoverage=${policy.minTermCoverage} requireKnownIdentifiers=${policy.requireKnownIdentifiers}`;
}

/** `npm run eval:confidence`: how the gate policy was chosen on the calibration split, and how it fares on the validation split. */
export function formatCalibration(report: CalibrationReport, info?: EvalRunInfo) {
  const section = (title: string, result: SweepResult) => [
    `${title}: ${policyText(result.policy)}`,
    `  calibration split (${report.calibrationQueries} queries) - used for the choice`,
    ...answerabilityRows(result.calibration.metrics),
    ...misclassified(result.calibration),
    `  validation split (${report.validationQueries} queries) - reported only, never used to choose`,
    ...answerabilityRows(result.validation.metrics),
    ...misclassified(result.validation),
  ];

  return [
    "Confidence calibration",
    ...(info ? runHeader(info) : []),
    `Objective: the highest specificity among policies that keep recall >= ${fixed(report.objective.minRecall)} on the calibration split.`,
    "A small local dataset - differences of one or two questions are noise, not evidence. See docs/evaluation.md.",
    "",
    "Best policies on the calibration split:",
    `  ${"semantic".padStart(8)} ${"coverage".padStart(8)} identifiers   recall   spec    FPR    FNR   TP FN FP TN`,
    ...report.top.map(({ policy, calibration }) => {
      const m = calibration.metrics;
      return `  ${fixed(policy.minSemanticScore).padStart(8)} ${fixed(policy.minTermCoverage).padStart(8)} ${(policy.requireKnownIdentifiers ? "required" : "ignored").padStart(11)}   ${orNa(m.recall).padStart(6)} ${orNa(m.specificity).padStart(6)} ${orNa(m.falsePositiveRate).padStart(6)} ${orNa(m.falseNegativeRate).padStart(6)}   ${m.tp} ${m.fn} ${m.fp} ${m.tn}`;
    }),
    "",
    ...section("Chosen by calibration", report.chosen),
    "",
    ...section("Shipped policy", report.committed),
    report.committedIsChosen
      ? "The shipped policy is the one calibration chooses."
      : "The shipped policy differs from the one calibration chooses: review it (and docs/evaluation.md) before changing anything.",
  ].join("\n");
}
