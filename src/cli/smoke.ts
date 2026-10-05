// The smoke flow indexes and answers through the real application, which logs each operation. This command prints its own report
// and nothing else, so the logger is silenced *before* it is first imported (hence the dynamic import below). Set LOG_LEVEL to see the logs.
process.env.LOG_LEVEL ??= "silent";

const { runSmokeFlow, SmokeFailure } = await import("./smoke-flow.js");
const { APPLICATION_VERSION } = await import("../shared/version.js");
const { formatCliFailure } = await import("./run-cli.js");

/**
 * `npm run smoke`: can this build start with its local infrastructure? It starts the real application core (migrations, FTS5,
 * repositories, file storage, retrieval, use cases) in a temporary directory around OFFLINE providers, runs the whole document
 * lifecycle - ingest, ask, duplicate, replace, backup, verify, restore into a new installation, delete, integrity - and
 * removes the directory. No Telegram, no OpenAI, no credentials, no network; it never touches DATA_DIR.
 * Exit code 0 when every step behaved, 1 (naming the step) when one did not.
 */
try {
  const started = Date.now();
  const { steps } = await runSmokeFlow();
  console.log(`telegram-rag-bot ${APPLICATION_VERSION} · Node ${process.versions.node} · ${process.platform}/${process.arch}\n`);
  for (const step of steps) console.log(`ok  ${step.name.padEnd(10)} ${step.detail}`);
  console.log(`\nSmoke test passed in ${Date.now() - started} ms.`);
} catch (error) {
  console.error(error instanceof SmokeFailure ? `Smoke test FAILED at ${error.message}` : `Smoke test FAILED: ${formatCliFailure(error)}`);
  process.exitCode = 1;
}
