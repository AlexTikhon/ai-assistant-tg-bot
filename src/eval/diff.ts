import type { EvalExport } from "./export.js";

export type LabelledExport = { label: string; result: EvalExport };

const fixed = (value: number | null) => (value === null ? "n/a" : value.toFixed(2));
const delta = (a: number | null, b: number | null) =>
  a === null || b === null ? "n/a" : `${b - a >= 0 ? "+" : "-"}${Math.abs(b - a).toFixed(2)}`;

/**
 * Two saved evaluation results side by side - typically the offline run and the live run of the same
 * dataset. Only retrieval and answerability metrics are compared. Cosine similarities are not: every
 * embedding model has its own scale, so a score from one model says nothing about another.
 */
export function formatExportDiff(a: LabelledExport, b: LabelledExport) {
  const warnings: string[] = [];
  if (a.result.dataset.version !== b.result.dataset.version) {
    warnings.push(`dataset version ${a.result.dataset.version} vs ${b.result.dataset.version}: the questions differ`);
  }
  if (a.result.dataset.queries !== b.result.dataset.queries) {
    warnings.push(`${a.result.dataset.queries} vs ${b.result.dataset.queries} queries: the runs did not ask the same questions`);
  }
  const profileA = a.result.index.profile;
  const profileB = b.result.index.profile;
  if (profileA.chunkSize !== profileB.chunkSize || profileA.chunkOverlap !== profileB.chunkOverlap || profileA.chunkingVersion !== profileB.chunkingVersion) {
    warnings.push(
      `chunking differs (${profileA.chunkSize}/${profileA.chunkOverlap} vs ${profileB.chunkSize}/${profileB.chunkOverlap}): the chunks are not the same`,
    );
  }
  if (JSON.stringify(a.result.configuration.retrieval) !== JSON.stringify(b.result.configuration.retrieval)) {
    warnings.push("retrieval settings differ between the runs");
  }

  const row = (name: string, x: number | null, y: number | null) => `  ${name.padEnd(20)} ${fixed(x).padStart(8)} ${fixed(y).padStart(8)} ${delta(x, y).padStart(8)}`;
  const counts = (result: EvalExport) => `${result.answerability.tp}/${result.answerability.fn}/${result.answerability.fp}/${result.answerability.tn}`;
  const ks = a.result.metrics.ks.filter((k) => b.result.metrics.ks.includes(k));

  return [
    `Comparing ${a.label} (${a.result.embeddings.model}${a.result.embeddings.live ? ", live" : ", offline"}) with ${b.label} (${b.result.embeddings.model}${b.result.embeddings.live ? ", live" : ", offline"})`,
    `Dataset version ${a.result.dataset.version} / ${b.result.dataset.version}, index fingerprints ${a.result.index.fingerprint} / ${b.result.index.fingerprint}`,
    ...warnings.map((warning) => `WARNING: ${warning}`),
    "",
    "Cosine similarities of different embedding models are not comparable (each model has its own scale), so none are compared here -",
    "only retrieval and answerability metrics. The gate policy of each run is listed below; re-calibrate it for a different model.",
    "",
    `  ${"".padEnd(20)} ${a.label.slice(0, 8).padStart(8)} ${b.label.slice(0, 8).padStart(8)} ${"change".padStart(8)}`,
    ...ks.map((k) => row(`Recall@${k}`, a.result.metrics.overall.recallAt[k], b.result.metrics.overall.recallAt[k])),
    row("MRR", a.result.metrics.overall.mrr, b.result.metrics.overall.mrr),
    "",
    "Answerability gate (positive = let through to the model)",
    `  ${"TP/FN/FP/TN".padEnd(20)} ${counts(a.result).padStart(8)} ${counts(b.result).padStart(8)}`,
    row("precision", a.result.answerability.precision, b.result.answerability.precision),
    row("recall", a.result.answerability.recall, b.result.answerability.recall),
    row("specificity", a.result.answerability.specificity, b.result.answerability.specificity),
    row("false-positive rate", a.result.answerability.falsePositiveRate, b.result.answerability.falsePositiveRate),
    row("false-negative rate", a.result.answerability.falseNegativeRate, b.result.answerability.falseNegativeRate),
    "",
    `Policy ${a.label}: ${JSON.stringify(a.result.configuration.confidencePolicy)}`,
    `Policy ${b.label}: ${JSON.stringify(b.result.configuration.confidencePolicy)}`,
  ].join("\n");
}
