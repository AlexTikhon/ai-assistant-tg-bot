import "dotenv/config";
import "./quiet-logs.js";
import path from "node:path";
import { loadToolConfig } from "../config/config.js";
import { verifyBackup } from "../infrastructure/backup/verify-backup.js";
import { formatVerification, parseVerifyArgs, VERIFY_USAGE } from "./backup-cli.js";
import { printUsage, runCli } from "./run-cli.js";

/** `npm run backup:verify -- <directory>`. Read-only; exit code 1 when the backup has problems. */
async function main() {
  const command = parseVerifyArgs(process.argv.slice(2));

  if (command.kind !== "run") return printUsage(command, VERIFY_USAGE);

  const config = loadToolConfig();
  const result = await verifyBackup(path.resolve(command.directory), {
    recipe: { embeddingModel: config.openai.embeddingsModel, ...config.chunking },
    now: Date.now,
    allowIncomplete: command.allowIncomplete,
  });
  console.log(formatVerification(result));
  return result.ok ? 0 : 1;
}

runCli(main);
