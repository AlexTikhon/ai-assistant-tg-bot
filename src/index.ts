import "dotenv/config";
import { createApplication } from "./composition-root.js";
import { loadConfig } from "./config/config.js";
import { runApplication } from "./lifecycle.js";
import { logger } from "./shared/logger.js";
import { registerSecret } from "./shared/scrub.js";
import { startBot } from "./startup.js";

/** Reads the configuration and teaches the output scrubber its secrets, so any output containing them - whatever shape they have - is redacted. */
function readConfig() {
  const config = loadConfig();
  registerSecret(config.telegram.botToken);
  registerSecret(config.openai.apiKey);
  return config;
}

const { exitCode } = await startBot({ readConfig, createApplication, runApplication, log: logger });
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
