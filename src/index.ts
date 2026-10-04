import "dotenv/config";
import { createApplication } from "./composition-root.js";
import { loadConfig } from "./config/config.js";
import { runApplication } from "./lifecycle.js";
import { logger } from "./shared/logger.js";

try {
  const config = loadConfig();
  const app = createApplication(config);

  try {
    await app.checkIndex().catch((err) => logger.warn({ err }, "Index compatibility check failed"));
    await runApplication(app);
    logger.info({ env: config.nodeEnv }, "Application started");
  } catch (error) {
    app.close();
    throw error;
  }
} catch (err) {
  logger.fatal({ err }, "Failed to start application");
  process.exitCode = 1;
}
