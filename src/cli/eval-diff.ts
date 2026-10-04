import fs from "node:fs";
import path from "node:path";
import { formatExportDiff } from "../eval/diff.js";
import type { EvalExport } from "../eval/export.js";

const USAGE = `Compares two saved evaluation results (the JSON written by npm run eval:retrieval -- --json), for example
the offline run and the live run of the same dataset. Retrieval and answerability metrics only: cosine scores of
different embedding models are not comparable.

Usage: npm run eval:diff -- <first.json> <second.json>`;

function load(file: string): EvalExport {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<EvalExport>;
  if (!parsed.exportVersion || !parsed.metrics || !parsed.answerability || !parsed.dataset || !parsed.index) {
    throw new Error(`${file} is not an evaluation result (expected the output of eval:retrieval --json).`);
  }
  return parsed as EvalExport;
}

const label = (file: string) => path.basename(file, path.extname(file));

/** `npm run eval:diff`. Reads two files, prints a comparison, calls no API. */
export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.length !== 2) {
    console.log(USAGE);
    return argv.includes("--help") ? 0 : 1;
  }
  const [first, second] = argv;
  console.log(formatExportDiff({ label: label(first), result: load(first) }, { label: label(second), result: load(second) }));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
