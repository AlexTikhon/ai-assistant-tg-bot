import "dotenv/config";

// Indexing the fixture corpus logs one line per document. An evaluation run should print its report and
// nothing else, so the logger is silenced *before* it is first imported (hence the dynamic import below).
process.env.LOG_LEVEL = process.env.EVAL_LOG_LEVEL ?? "silent";

const { main } = await import("./eval-retrieval-main.js");

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  return 1;
});
