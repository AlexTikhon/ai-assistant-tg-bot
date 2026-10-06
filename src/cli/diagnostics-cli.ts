import { describeErrorSafely } from "../shared/scrub.js";
import { parseArgs } from "node:util";
import type { Diagnostics } from "../infrastructure/diagnostics/collect-diagnostics.js";

export const DIAGNOSTICS_USAGE = `Prints what a bug report needs, and nothing sensitive.

Usage: npm run diagnostics [-- --json]

Shows the application, Node and SQLite versions, the database schema, document / chunk / file counts, storage use, how many
documents have an outdated or damaged index, the retrieval confidence mode and the configured model names.
It never prints API keys, the bot token, document text, questions, answers, user ids, file names or full paths.
Read-only; needs no API key or bot token.`;

export type DiagnosticsCommand = { kind: "run"; json: boolean } | { kind: "help" } | { kind: "error"; message: string };

export function parseDiagnosticsArgs(argv: string[]): DiagnosticsCommand {
  try {
    const { values } = parseArgs({ args: argv, options: { json: { type: "boolean" }, help: { type: "boolean" } }, strict: true, allowPositionals: false });
    return values.help ? { kind: "help" } : { kind: "run", json: values.json ?? false };
  } catch (error) {
    return { kind: "error", message: describeErrorSafely(error) };
  }
}

const megabytes = (bytes: number) => `${Math.round((bytes / (1024 * 1024)) * 100) / 100} MB`;

export function formatDiagnostics(d: Diagnostics) {
  const lines = [
    `Application     version ${d.application.version} · Node ${d.application.node} · ${d.application.platform}/${d.application.arch}`,
    `SQLite          ${d.sqlite.version} · FTS5 ${d.sqlite.fts5Compiled ? "compiled in" : "MISSING"}, index ${d.sqlite.fullTextIndexPresent ? "present" : "MISSING"}`,
    `Schema          version ${d.sqlite.schemaVersion} (this application expects ${d.sqlite.expectedSchemaVersion})`,
    `Connection      journal_mode=${d.sqlite.pragmas.journalMode} synchronous=${d.sqlite.pragmas.synchronous} foreign_keys=${d.sqlite.pragmas.foreignKeys} busy_timeout=${d.sqlite.pragmas.busyTimeoutMs}ms (as of this tool's own connection)`,
    `Data            directory "${d.data.directoryName}" ${d.data.directoryWritable ? "(writable)" : "(NOT writable)"} · database ${megabytes(d.data.databaseBytes)}`,
    `Contents        ${d.data.users} users · ${d.data.documents} documents · ${d.data.chunks} chunks · ${d.data.feedbackRatings} feedback ratings`,
    `Files           ${d.data.storedFiles} stored (${megabytes(d.data.storedFileBytes)}) · ${d.data.unreferencedFiles} unreferenced · ${d.data.temporaryFiles} temporary`,
    d.index
      ? `Index health    ${d.index.staleDocuments} documents outdated · ${d.index.corruptIndexDocuments} partly unreadable · ${d.index.unindexedDocuments} without chunks · ${d.index.missingOriginals} original files missing`
      : "Index health    not checked (the schema is not the current one)",
    `Restore         ${d.data.restoreStagingDirectories} interrupted staging directories · ${d.data.previousInstallations} kept previous installations`,
    `Retrieval       confidence gate: ${d.configuration.retrievalConfidenceMode}${d.configuration.retrievalConfidenceMode === "shadow" ? " (decisions are computed and logged, never applied)" : ""}`,
    `Models          chat ${d.configuration.chatModel} · embeddings ${d.configuration.embeddingsModel} · transcription ${d.configuration.transcribeModel}`,
    `Chunking        size ${d.configuration.chunkSize}, overlap ${d.configuration.chunkOverlap} · max ${d.configuration.maxChunksPerDocument} chunks and ${d.configuration.maxPdfPages} PDF pages per document`,
  ];
  if (d.warnings.length > 0) {
    lines.push("", `WARNINGS (${d.warnings.length})`, ...d.warnings.map((warning) => `  - ${warning}`));
  }
  return lines.join("\n");
}
