import { parseArgs } from "node:util";
import { formatBenchmark, runBenchmark } from "../eval/benchmark.js";

const USAGE = `Retrieval benchmark on deterministic generated data (not a test: it never fails because a machine is slow).

Usage: npm run bench:retrieval -- [options]

  --sizes <list>   chunk counts, comma separated   (default 1000,5000,10000)
  --dim <n>        embedding dimension             (default 1536, like text-embedding-3-small)
  --users <n>      users sharing the database; only user-0 is queried (default 1)
  --runs <n>       measured repetitions per stage  (default 20)
  --explain        also print the query plan of the lexical search
  --help`;

function main(): number {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        sizes: { type: "string" },
        dim: { type: "string" },
        users: { type: "string" },
        runs: { type: "string" },
        explain: { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n\n${USAGE}`);
    return 1;
  }

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const sizes = (values.sizes ?? "1000,5000,10000").split(",").map(Number);
  const [dimension, users, runs] = [values.dim ?? "1536", values.users ?? "1", values.runs ?? "20"].map(Number);
  if ([...sizes, dimension, users, runs].some((value) => !Number.isInteger(value) || value < 1)) {
    console.error(`All numeric options must be positive integers.\n\n${USAGE}`);
    return 1;
  }

  void runBenchmark({ sizes, dimension, users, runs, warmup: 3, seed: 20260101, explain: values.explain }).then(
    (results) => console.log(formatBenchmark(results, { dimension, users, runs })),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
  return 0;
}

process.exitCode = main();
