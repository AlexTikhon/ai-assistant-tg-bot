import "dotenv/config";
import "./quiet-logs.js";
import { createReindexTool } from "../composition-root.js";
import { loadToolConfig, openAiConfig } from "../config/config.js";
import { formatProgress, formatReport, parseReindexArgs, REINDEX_USAGE } from "./reindex-cli.js";
import { runCli } from "./run-cli.js";

/**
 * `npm run reindex [-- --all | --document <id>] [--rechunk] [--dry-run]`. Exit code 1 on bad input or failed
 * documents. Only a real run needs OPENAI_API_KEY (and never TELEGRAM_BOT_TOKEN): a dry run makes no provider call.
 */
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

  const config = loadToolConfig();
  const tool = createReindexTool(config, { openaiApiKey: command.dryRun ? undefined : openAiConfig.load() });
  try {
    const report = await tool.reindex.execute({
      scope: command.scope,
      rechunk: command.rechunk,
      dryRun: command.dryRun,
      // A dry run prints its plan, with reasons, as part of the report.
      onProgress: (progress) => progress.outcome !== "planned" && console.log(formatProgress(progress)),
    });
    console.log(formatReport(report));
    return report.failed.length > 0 ? 1 : 0;
  } finally {
    tool.close();
  }
}

runCli(main);
