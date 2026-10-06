import "dotenv/config";
import "./quiet-logs.js";
import { loadToolConfig } from "../config/config.js";
import { collectDiagnostics } from "../infrastructure/diagnostics/collect-diagnostics.js";
import { openDatabaseReadOnly } from "../infrastructure/sqlite/database.js";
import { APPLICATION_VERSION } from "../shared/version.js";
import { DIAGNOSTICS_USAGE, formatDiagnostics, parseDiagnosticsArgs } from "./diagnostics-cli.js";
import { printUsage, runCli } from "./run-cli.js";

/** `npm run diagnostics [-- --json]`: a safe, read-only summary for bug reports. Exit code 1 only when it cannot read the database at all. */
async function main() {
  const command = parseDiagnosticsArgs(process.argv.slice(2));

  if (command.kind !== "run") return printUsage(command, DIAGNOSTICS_USAGE);

  const config = loadToolConfig();
  const db = openDatabaseReadOnly(config.storage.sqlitePath, { requireCurrentSchema: false });
  try {
    const diagnostics = await collectDiagnostics({
      db,
      dataDir: config.storage.dataDir,
      sqlitePath: config.storage.sqlitePath,
      filesDir: config.storage.filesDir,
      application: { version: APPLICATION_VERSION },
      recipe: { embeddingModel: config.openai.embeddingsModel, ...config.chunking },
      configuration: {
        retrievalConfidenceMode: config.retrieval.confidenceMode,
        chatModel: config.openai.chatModel,
        embeddingsModel: config.openai.embeddingsModel,
        transcribeModel: config.openai.transcribeModel,
        chunkSize: config.chunking.chunkSize,
        chunkOverlap: config.chunking.chunkOverlap,
        maxChunksPerDocument: config.limits.maxChunksPerDocument,
        maxPdfPages: config.limits.maxPdfPages,
      },
    });
    console.log(command.json ? JSON.stringify(diagnostics, null, 2) : formatDiagnostics(diagnostics));
    return 0;
  } finally {
    db.close();
  }
}

runCli(main);
