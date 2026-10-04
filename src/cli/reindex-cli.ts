import { parseArgs } from "node:util";
import type {
  ReindexProgress,
  ReindexReport,
  ReindexScope,
} from "../application/use-cases/run-reindex.use-case.js";

export const REINDEX_USAGE = `Re-embeds stored chunks with the configured OPENAI_EMBEDDINGS_MODEL.

Usage: npm run reindex -- [options]

  (no options)        re-index documents whose vectors are stale (other model, wrong dimension, unreadable)
  --all               re-index every document
  --document <id>     re-index one document
  --dry-run           only list what would be re-indexed (no OpenAI calls, no changes)
  --help              show this help

Chunk text is reused as stored; to apply new CHUNK_SIZE/CHUNK_OVERLAP settings, delete and re-upload the document.`;

export type ReindexCommand =
  | { kind: "run"; scope: ReindexScope; dryRun: boolean }
  | { kind: "help" }
  | { kind: "error"; message: string };

/** Parses `npm run reindex -- ...` arguments. Pure: never exits or prints. */
export function parseReindexArgs(argv: string[]): ReindexCommand {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        all: { type: "boolean" },
        document: { type: "string" },
        "dry-run": { type: "boolean" },
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
  if (values.all && values.document !== undefined) {
    return { kind: "error", message: "--all and --document cannot be used together." };
  }

  const scope: ReindexScope =
    values.document !== undefined
      ? { kind: "document", documentId: values.document }
      : values.all
        ? { kind: "all" }
        : { kind: "stale" };

  return { kind: "run", scope, dryRun: values["dry-run"] ?? false };
}

const PROGRESS_VERB = { planned: "would re-index", reindexed: "re-indexed", failed: "FAILED" } as const;

export function formatProgress(progress: ReindexProgress) {
  const prefix = `[${progress.position}/${progress.total}] ${PROGRESS_VERB[progress.outcome]} ${progress.fileName} (${progress.documentId})`;
  return progress.outcome === "failed" ? `${prefix}: ${progress.reason}` : `${prefix}: ${progress.chunks} chunks`;
}

export function formatReport(report: ReindexReport) {
  if (report.documents === 0) {
    return `Nothing to re-index: all chunks already match ${report.model}.`;
  }
  if (report.dryRun) {
    return `Dry run: ${report.documents} documents (${report.chunks} chunks) would be re-indexed with ${report.model}.`;
  }

  const lines = [
    `${report.succeeded} of ${report.documents} documents re-indexed (${report.chunksReindexed} chunks) with ${report.model}.`,
  ];
  if (report.failed.length > 0) {
    lines.push(`${report.failed.length} failed; their previous data is unchanged:`);
    lines.push(...report.failed.map((item) => `  - ${item.fileName} (${item.documentId}): ${item.reason}`));
    lines.push("Run `npm run reindex` again to retry only what is still stale.");
  }
  return lines.join("\n");
}
