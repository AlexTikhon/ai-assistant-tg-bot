import "dotenv/config";
import { createReindexTool } from "../composition-root.js";
import { loadConfig } from "../config/config.js";
import { formatProgress, formatReport, parseReindexArgs, REINDEX_USAGE } from "./reindex-cli.js";

/** `npm run reindex [-- --all | --document <id>] [--dry-run]`. Exit code 1 on bad input or failed documents. */
async function main() {
  const command = parseReindexArgs(process.argv.slice(2));

  if (command.kind === "help") {
    console.log(REINDEX_USAGE);
    return 0;
  }
  if (command.kind === "error") {
    console.error(`${command.message}\n\n${REINDEX_USAGE}`);
    return 1;
  }

  const tool = createReindexTool(loadConfig());
  try {
    const report = await tool.reindex.execute({
      scope: command.scope,
      dryRun: command.dryRun,
      onProgress: (progress) => console.log(formatProgress(progress)),
    });
    console.log(formatReport(report));
    return report.failed.length > 0 ? 1 : 0;
  } finally {
    tool.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
