import "dotenv/config";
import { createApplication } from "./composition-root.js";
import { loadConfig } from "./config/config.js";
import { runApplication } from "./lifecycle.js";
import { logger } from "./shared/logger.js";
import { startBot } from "./startup.js";

const { exitCode } = await startBot({ readConfig: loadConfig, createApplication, runApplication, log: logger });
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
