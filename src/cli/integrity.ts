import "dotenv/config";
import { createIntegrityTool } from "../composition-root.js";
import { loadToolConfig } from "../config/config.js";
import { formatIntegrityReport, formatRepairResult, INTEGRITY_USAGE, parseIntegrityArgs } from "./integrity-cli.js";

/**
 * `npm run integrity [-- --repair [--remove-orphans]] [--skip-hashes] [--json]`.
 * Read-only unless --repair is given. Needs no API key and no bot token. Exit code 1 when errors remain
 * (or on bad input), 0 otherwise - warnings alone do not fail the run.
 */
async function main() {
  const command = parseIntegrityArgs(process.argv.slice(2));

  if (command.kind === "help") {
    console.log(INTEGRITY_USAGE);
    return 0;
  }
  if (command.kind === "error") {
    console.error(`${command.message}\n\n${INTEGRITY_USAGE}`);
    return 1;
  }

  const tool = createIntegrityTool(loadToolConfig(), { writable: command.repair, verifyHashes: command.verifyHashes });
  try {
    if (command.repair && tool.repair) {
      const result = await tool.repair.execute({ removeOrphans: command.removeOrphans });
      console.log(command.json ? JSON.stringify(result, null, 2) : formatRepairResult(result));
      return result.after.summary.errors > 0 || result.actions.some((action) => action.kind === "failed") ? 1 : 0;
    }

    const report = await tool.inspect.execute();
    console.log(command.json ? JSON.stringify(report, null, 2) : formatIntegrityReport(report));
    return report.summary.errors > 0 ? 1 : 0;
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
