import { parseArgs } from "node:util";
import type { IntegrityIssue, IntegrityReport } from "../application/use-cases/inspect-integrity.use-case.js";
import type { RepairAction, RepairResult } from "../application/use-cases/repair-integrity.use-case.js";

export const INTEGRITY_USAGE = `Checks the stored data for inconsistencies: documents, chunks, vectors, the full-text index, the
original files, content hashes and index profiles. By default it is READ-ONLY: it changes nothing.

Usage: npm run integrity -- [options]

  (no options)       report problems and which command fixes each one
  --repair           also apply the safe, deterministic repairs and print exactly what changed:
                       - rebuild the full-text index
                       - record missing content hashes of documents whose original file is present
                       - delete temporary leftovers of interrupted writes (older than one hour)
  --remove-orphans   with --repair: also delete stored files no document refers to (older than 24 hours)
  --skip-hashes      do not read every stored file to verify its content hash (faster)
  --json             machine-readable output
  --help             show this help

Repair never deletes documents or chunks, never regenerates embeddings, never calls OpenAI, never replaces
files and never guesses ownership. Re-embedding and re-chunking stay explicit: npm run reindex.`;

export type IntegrityCommand =
  | { kind: "run"; repair: boolean; removeOrphans: boolean; verifyHashes: boolean; json: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };

/** Parses `npm run integrity -- ...` arguments. Pure: never exits or prints. */
export function parseIntegrityArgs(argv: string[]): IntegrityCommand {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        repair: { type: "boolean" },
        "remove-orphans": { type: "boolean" },
        "skip-hashes": { type: "boolean" },
        json: { type: "boolean" },
        help: { type: "boolean" },
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
  if (values["remove-orphans"] && !values.repair) {
    return { kind: "error", message: "--remove-orphans only works together with --repair." };
  }

  return {
    kind: "run",
    repair: values.repair ?? false,
    removeOrphans: values["remove-orphans"] ?? false,
    verifyHashes: !(values["skip-hashes"] ?? false),
    json: values.json ?? false,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function formatIssue(issue: IntegrityIssue) {
  const subject = issue.documentId ? ` (document ${issue.documentId})` : "";
  const lines = [`  [${issue.code}] ${issue.message}${subject}`];
  if (issue.remedy) {
    lines.push(`      fix: ${issue.remedy}`);
  }
  return lines;
}

export function formatIntegrityReport(report: IntegrityReport) {
  const { summary } = report;
  const lines = [`Checked ${plural(summary.documents, "document", "documents")} and ${plural(summary.chunks, "chunk", "chunks")}.`, ""];
  const errors = report.issues.filter((issue) => issue.severity === "error");
  const warnings = report.issues.filter((issue) => issue.severity === "warning");

  if (report.issues.length === 0) {
    lines.push("No problems found.");
  }
  if (errors.length > 0) {
    lines.push(`ERRORS (${errors.length})`, ...errors.flatMap(formatIssue), "");
  }
  if (warnings.length > 0) {
    lines.push(`WARNINGS (${warnings.length})`, ...warnings.flatMap(formatIssue), "");
  }

  if (summary.needsReembed > 0 || summary.needsRechunk > 0) {
    lines.push("Index updates (each needs OpenAI embedding calls; nothing is done automatically):");
    if (summary.needsReembed > 0) {
      lines.push(`  ${plural(summary.needsReembed, "document needs", "documents need")} re-embedding: npm run reindex`);
    }
    if (summary.needsRechunk > 0) {
      lines.push(`  ${plural(summary.needsRechunk, "document needs", "documents need")} re-chunking: npm run reindex -- --rechunk`);
    }
    lines.push(
      `  about ${plural(summary.chunksToEmbed, "chunk", "chunks")} would be embedded; \`npm run reindex -- --dry-run\` shows exactly which documents and why, without any API call.`,
      "",
    );
  }

  lines.push(`Result: ${plural(summary.errors, "error", "errors")}, ${plural(summary.warnings, "warning", "warnings")}.`);
  return lines.join("\n");
}

function describeAction(action: RepairAction) {
  switch (action.kind) {
    case "rebuilt-full-text-index":
      return `rebuilt the full-text index and verified it (${action.verified.chunks} chunks indexed, ${action.verified.searchesChecked} sample searches ok, content ${action.verified.contentCheck === "compared" ? "compared with the chunk text" : "comparison skipped"})`;
    case "removed-restore-staging":
      return `removed the working directory of an interrupted restore (${action.name})`;
    case "backfilled-content-hash":
      return `recorded the content hash of ${action.fileName} (${action.documentId})`;
    case "removed-temporary-file":
      return `removed temporary file ${action.file}`;
    case "removed-orphan-file":
      return `removed orphan file ${action.file}`;
    case "failed":
      return `FAILED ${action.step}: ${action.reason}`;
  }
}

export function formatRepairResult(result: RepairResult) {
  const lines =
    result.actions.length === 0
      ? ["Nothing was repaired: no problem that can be fixed safely and automatically."]
      : ["Repaired:", ...result.actions.map((action) => `  - ${describeAction(action)}`)];

  lines.push(
    "Repair never deletes documents, never regenerates embeddings and never calls OpenAI; use `npm run reindex` for that.",
    "",
    "After the repair:",
    formatIntegrityReport(result.after),
  );
  return lines.join("\n");
}
