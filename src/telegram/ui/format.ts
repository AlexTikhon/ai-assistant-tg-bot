import type { AnswerQuestionResult } from "../../application/use-cases/answer-question.use-case.js";
import type { IngestDocumentResult } from "../../application/use-cases/ingest-document.use-case.js";
import { formatSourceLocation } from "../../core/citations.js";
import type { DocumentRecord } from "../../core/document.js";
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

export function formatDocumentList(documents: DocumentRecord[]) {
  return documents.map((document) => `${document.id}\n${document.fileName} (${document.textLength} chars)`).join("\n\n");
}

export function formatIngestResult(result: IngestDocumentResult) {
  return [
    `Indexed ${result.fileName}.`,
    `Document ID: ${result.documentId}`,
    `Chunks: ${result.chunksCount}`,
    "You can now ask questions.",
  ].join("\n");
}

export function formatSummary(fileName: string, summary: string) {
  return `Summary for ${fileName}:\n\n${summary}`;
}
