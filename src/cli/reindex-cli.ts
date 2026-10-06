import { describeErrorSafely } from "../shared/scrub.js";
import { parseArgs } from "node:util";
import { MARKDOWN_EXTRACTOR_VERSION } from "../core/index-profile.js";
import type { StaleReason } from "../core/index-profile.js";
import type {
  ReindexAction,
  ReindexProgress,
  ReindexReport,
  ReindexScope,
} from "../application/use-cases/run-reindex.use-case.js";

export const REINDEX_USAGE = `Brings stored documents in line with the configured index recipe
(OPENAI_EMBEDDINGS_MODEL, CHUNK_SIZE, CHUNK_OVERLAP and the built-in chunking/extraction versions).

Usage: npm run reindex -- [options]

  (no options)        re-embed documents whose vectors are outdated (other model, wrong dimension, unreadable);
                      keeps their chunks. Other kinds of staleness are only reported.
  --rechunk           also rebuild documents with a different chunk size/overlap/algorithm or extraction
                      (e.g. PDFs without page numbers, Markdown without sections) from their original files
  --all               every document (re-embed; with --rechunk: re-chunk)
  --document <id>     one document
  --dry-run           show which documents are stale and why, and what would be done
                      (no OpenAI calls, no changes, no API key needed)
  --help              show this help

Re-embed: new vectors for the stored chunk text.   Re-chunk: re-read the original file, split it again, embed the new chunks.
Either way the old index stays in place until the new one is complete.`;

export type ReindexCommand =
  | { kind: "run"; scope: ReindexScope; dryRun: boolean; rechunk: boolean }
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
        rechunk: { type: "boolean" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
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
  if (values.all && values.document !== undefined) {
    return { kind: "error", message: "--all and --document cannot be used together." };
  }

  const scope: ReindexScope =
    values.document !== undefined
      ? { kind: "document", documentId: values.document }
      : values.all
        ? { kind: "all" }
        : { kind: "stale" };

  return { kind: "run", scope, dryRun: values["dry-run"] ?? false, rechunk: values.rechunk ?? false };
}

const DONE: Record<ReindexAction, string> = { reembed: "re-embedded", rechunk: "re-chunked" };
const PLANNED: Record<ReindexAction, string> = { reembed: "would re-embed", rechunk: "would re-chunk" };
const FAILED: Record<ReindexAction, string> = { reembed: "re-embedding", rechunk: "re-chunking" };

export function formatProgress(progress: ReindexProgress) {
  const verb =
    progress.outcome === "planned"
      ? PLANNED[progress.action]
      : progress.outcome === "failed"
        ? `FAILED ${FAILED[progress.action]}`
        : DONE[progress.action];
  const prefix = `[${progress.position}/${progress.total}] ${verb} ${progress.fileName} (${progress.documentId})`;
  return progress.outcome === "failed" ? `${prefix}: ${progress.reason}` : `${prefix}: ${progress.chunks} chunks`;
}

const FIELD_LABEL: Record<StaleReason["field"], string> = {
  embeddingModel: "embedding model",
  embeddingDimension: "embedding dimension",
  chunkSize: "chunk size",
  chunkOverlap: "chunk overlap",
  chunkingVersion: "chunking version",
  extractorVersion: "extractor version",
  vectors: "stored vectors",
};

function formatValue(field: StaleReason["field"], value: string | number | null) {
  return field === "chunkingVersion" ? `v${value}` : String(value);
}

function formatReasons(reasons: StaleReason[]) {
  return reasons.flatMap((reason) => [
    `  ${FIELD_LABEL[reason.field]}:`,
    `    ${formatValue(reason.field, reason.from)} -> ${formatValue(reason.field, reason.to)}`,
  ]);
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Which workflow a stale document needs: a different chunk layout or extraction needs a re-chunk (which also re-embeds); only outdated vectors need a re-embed. */
function needsOf(reasons: StaleReason[]): ReindexAction {
  return reasons.some((reason) => reason.kind === "chunking" || reason.kind === "extractor") ? "rechunk" : "reembed";
}

const NEEDS_COMMAND: Record<ReindexAction, string> = {
  reembed: "needs re-embed: npm run reindex",
  rechunk: "needs re-chunk: npm run reindex -- --rechunk",
};

/** A Markdown document whose recipe predates section-aware extraction: it works, but cites chunk numbers instead of sections. */
function predatesMarkdownSections(document: ReindexReport["stale"][number]) {
  return (
    document.fileName.toLowerCase().endsWith(".md") &&
    document.reasons.some((reason) => reason.field === "extractorVersion" && reason.to === MARKDOWN_EXTRACTOR_VERSION)
  );
}

function formatStaleDocuments(report: ReindexReport) {
  return report.stale.flatMap((document) => {
    const outcome = document.action ? PLANNED[document.action] : "not changed by this run (add --rechunk)";
    const note = predatesMarkdownSections(document)
      ? ["  Markdown section citations: indexed before section-aware extraction; it still answers questions but cites chunk numbers - a re-chunk adds the sections"]
      : [];
    return [
      `${document.fileName} (${document.documentId})`,
      ...formatReasons(document.reasons),
      ...note,
      `  -> ${outcome}`,
      `  ${NEEDS_COMMAND[needsOf(document.reasons)]}`,
      "",
    ];
  });
}

/** What to run next, per kind of staleness. Only for dry runs: a real run already did what it was asked. */
function formatNextSteps(report: ReindexReport) {
  const rechunk = report.stale.filter((document) => needsOf(document.reasons) === "rechunk").length;
  const reembed = report.stale.length - rechunk;
  if (report.stale.length === 0) {
    return [];
  }

  return [
    "Next steps (this dry run changed nothing; each of these calls the OpenAI embeddings API):",
    ...(reembed > 0 ? [`  ${plural(reembed, "document needs", "documents need")} re-embedding: npm run reindex`] : []),
    ...(rechunk > 0 ? [`  ${plural(rechunk, "document needs", "documents need")} re-chunking: npm run reindex -- --rechunk`] : []),
    "",
  ];
}

function formatSummary(report: ReindexReport) {
  const { summary } = report;
  const lines = [
    "Summary:",
    plural(summary.checked, "document checked", "documents checked"),
    plural(summary.embedding, "stale embedding", "stale embeddings"),
    `${summary.chunking} stale chunk ${summary.chunking === 1 ? "layout" : "layouts"}`,
    plural(summary.extractor, "extraction-version change", "extraction-version changes"),
  ];
  if (summary.unknownChunkLayout > 0) {
    lines.push(
      `${plural(summary.unknownChunkLayout, "document", "documents")} with an unrecorded chunk layout (indexed before recipes were tracked)`,
    );
  }
  return lines;
}

export function formatReport(report: ReindexReport) {
  const lines: string[] = [];

  if (report.dryRun) {
    lines.push(...formatStaleDocuments(report), ...formatSummary(report), "", ...formatNextSteps(report));
  }

  if (report.documents === 0) {
    lines.push(`Nothing to re-index: all chunks already match ${report.model}.`);
  } else if (report.dryRun) {
    lines.push(`Dry run: ${report.documents} documents (${report.chunks} chunks) would be re-indexed with ${report.model}.`);
  } else {
    lines.push(
      `${report.succeeded} of ${report.documents} documents re-indexed (${report.chunksReindexed} chunks) with ${report.model}.`,
      `${report.reembedded} re-embedded, ${report.rechunked} re-chunked.`,
    );
  }

  const untouched = report.stale.filter((document) => document.action === null).length;
  if (untouched > 0) {
    lines.push(
      `${plural(untouched, "stale document was", "stale documents were")} not changed by this run: ` +
        "chunk-layout and extraction changes need --rechunk.",
    );
  }

  if (report.failed.length > 0) {
    lines.push(`${report.failed.length} failed; their previous data is unchanged:`);
    lines.push(...report.failed.map((item) => `  - ${item.fileName} (${item.documentId}): ${item.reason}`));
    lines.push("Run `npm run reindex` again to retry only what is still stale.");
  }
  return lines.join("\n");
}
