import type { AnswerQuestionResult } from "../../application/use-cases/answer-question.use-case.js";
import type { IngestDocumentResult } from "../../application/use-cases/ingest-document.use-case.js";
import { formatSourceLocation } from "../../core/citations.js";
import type { DocumentRecord } from "../../core/document.js";

/**
 * Answer text followed by the numbered sources, in the order the model saw them, so "[2]" in the
 * answer is the line starting with [2] below. PDFs show the real pages they were taken from ("p. 8",
 * "pp. 12–13"), everything else the chunk position. Plain text on purpose: file names come from users and
 * are never parsed as markup.
 */
export function formatAnswer(result: AnswerQuestionResult) {
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
