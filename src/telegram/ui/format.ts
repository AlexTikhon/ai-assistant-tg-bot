import type { AnswerQuestionResult } from "../../application/use-cases/answer-question.use-case.js";
import type { IngestDocumentResult } from "../../application/use-cases/ingest-document.use-case.js";
import type { DocumentRecord } from "../../core/document.js";

/** Answer text followed by a "Sources" list with the cited parts grouped per document. */
export function formatAnswer(result: AnswerQuestionResult) {
  if (result.sources.length === 0) {
    return `${result.answer}\n\nSources:\n- none`;
  }

  const partsByDocument = new Map<string, { fileName: string; parts: number[] }>();
  for (const source of result.sources) {
    const entry = partsByDocument.get(source.documentId) ?? { fileName: source.fileName, parts: [] };
    entry.parts.push(source.chunkIndex + 1);
    partsByDocument.set(source.documentId, entry);
  }

  const lines = [...partsByDocument.values()].map(({ fileName, parts }) => {
    const sorted = [...new Set(parts)].sort((a, b) => a - b);
    return `- ${fileName} (${sorted.length === 1 ? "part" : "parts"} ${sorted.join(", ")})`;
  });

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
