import type { DocumentOverview } from "../../application/document-overview.js";
import type { AnswerQuestionResult } from "../../application/use-cases/answer-question.use-case.js";
import type { IngestDocumentResult } from "../../application/use-cases/ingest-document.use-case.js";
import type { ReplaceDocumentResult } from "../../application/use-cases/replace-document.use-case.js";
import { formatSourceLocation } from "../../core/citations.js";
import type { IndexHealth } from "../../core/index-health.js";
import { getFileExtension } from "../../shared/utils/path.js";
import { messages } from "./messages.js";

/**
 * Answer text followed by the numbered sources, in the order the model saw them, so "[2]" in the
 * answer is the line starting with [2] below. Each source shows the richest place known: the PDF pages
 * ("p. 8", "pp. 12–13"), the Markdown section ("Authentication > Refresh tokens") or the chunk position.
 * Plain text on purpose: file names and headings come from users and are never parsed as markup.
 *
 * When the documents hold too little evidence there is only one sentence: no sources, no scores, no reason.
 */
export function formatAnswer(result: AnswerQuestionResult) {
  if (result.kind === "insufficient-evidence") {
    return messages.insufficientEvidence;
  }
  if (result.sources.length === 0) {
    return `${result.answer}\n\nSources:\n- none`;
  }

  const lines = result.sources.map((source) => `[${source.rank}] ${source.fileName} · ${formatSourceLocation(source)}`);

  return `${result.answer}\n\nSources:\n${lines.join("\n")}`;
}

/** Sizes the way a person reads them: "1000 B", "2 KB", "2.9 KB", "1.5 MB". */
function formatSize(bytes: number) {
  const trim = (value: number) => String(Math.round(value * 10) / 10);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trim(bytes / 1024)} KB`;
  return `${trim(bytes / (1024 * 1024))} MB`;
}

const day = (timestamp: string) => timestamp.slice(0, 10);

/** A plain word for the index state. Internal details (profiles, hashes, dimensions) are for the operator. */
function describeHealth(health: IndexHealth) {
  const labels: Record<IndexHealth["state"], string> = {
    current: "ready",
    unindexed: "not searchable",
    "corrupt-index": "partly unreadable",
    "embedding-stale": "index outdated",
    "chunking-stale": "index outdated",
    "extractor-stale": "index outdated",
    "missing-file": "original file missing",
  };
  const extra = health.state !== "missing-file" && health.issues.includes("missing-file") ? " · original file missing" : "";
  return `${labels[health.state]}${extra}`;
}

function describeDates({ document }: DocumentOverview) {
  const added = `added ${day(document.createdAt)}`;
  return document.updatedAt ? `${added} · updated ${day(document.updatedAt)}` : added;
}

/** Compact: id on its own line (to copy into /delete, /summary, /replace), then name, size, dates, state. */
export function formatDocumentList(overviews: DocumentOverview[]) {
  return overviews
    .map((overview) => {
      const { document } = overview;
      return `${document.id}\n${document.fileName} · ${formatSize(document.fileSize)} · ${describeDates(overview)} · ${describeHealth(overview.health)}`;
    })
    .join("\n\n");
}

/**
 * What is known about where answers can point, from the stored chunks only (nothing is extracted for /doc). A PDF's page count is not
 * stored, only the last page that has indexed text, and it is labelled as such rather than as "pages".
 */
function describeProvenance(type: string, { provenance, chunksCount }: DocumentOverview) {
  if (chunksCount === 0) return [];
  if (type === "PDF") {
    return provenance.lastPage === null ? ["Page citations: not available (re-index it to add them)"] : [`Page citations: yes · last page with text: ${provenance.lastPage}`];
  }
  if (type === "MD") {
    return [provenance.sectionedChunks > 0 ? "Section citations: yes" : "Section citations: no"];
  }
  return [];
}

/** `/doc <id>`: what a user may want to know about one document. No hashes, fingerprints or dimensions. */
export function formatDocumentInfo(overview: DocumentOverview) {
  const { document } = overview;
  const type = getFileExtension(document.fileName).slice(1).toUpperCase() || "unknown";
  const lines = [
    document.fileName,
    `ID: ${document.id}`,
    `Type: ${type}`,
    `Size: ${formatSize(document.fileSize)}`,
    `Added: ${day(document.createdAt)}`,
  ];
  if (document.updatedAt) {
    lines.push(`Updated: ${day(document.updatedAt)}`);
  }
  if ((document.documentVersion ?? 1) > 1) {
    lines.push(`Version: ${document.documentVersion}`);
  }
  lines.push(`Chunks: ${overview.chunksCount}`);
  lines.push(...describeProvenance(type, overview));
  lines.push(`Status: ${describeHealth(overview.health)}`);
  return lines.join("\n");
}

export function formatIngestResult(result: IngestDocumentResult | ReplaceDocumentResult) {
  switch (result.kind) {
    case "created":
      return [
        `Indexed ${result.fileName}.`,
        `Document ID: ${result.documentId}`,
        `Chunks: ${result.chunksCount}`,
        "You can now ask questions.",
      ].join("\n");

    case "replaced":
      return [
        `Replaced ${result.fileName}.`,
        `Document ID: ${result.documentId} (unchanged)`,
        `Chunks: ${result.chunksCount}`,
        "Questions now use the new content.",
      ].join("\n");

    case "already-exists": {
      const lines = [messages.alreadyExists, `${result.fileName} · Document ID: ${result.documentId}`];
      if (result.restoredOriginal) {
        lines.push("Its original file had gone missing; it has been restored from this upload.");
      }
      if (result.health.state === "unindexed") {
        lines.push(`It cannot be searched right now. Send the file again with the caption /replace ${result.documentId} to rebuild it.`);
      } else if (result.health.issues.some((issue) => issue.endsWith("-stale") || issue === "corrupt-index")) {
        lines.push("Its search index is outdated, so answers may be less precise until it is refreshed.");
      }
      return lines.join("\n");
    }
  }
}

export function formatSummary(fileName: string, summary: string) {
  return `Summary for ${fileName}:\n\n${summary}`;
}
