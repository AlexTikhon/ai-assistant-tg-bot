// Prints the coverage totals (and the least-covered source files) as Markdown, for the CI job summary.
// Coverage is a diagnostic here: nothing fails because of a percentage.
import fs from "node:fs";

const file = "coverage/coverage-summary.json";
if (!fs.existsSync(file)) {
  console.log("No coverage summary was produced.");
  process.exit(0);
}

const summary = JSON.parse(fs.readFileSync(file, "utf-8"));
const pct = (entry) => `${entry.pct}%`;
const { total } = summary;

console.log("## Test coverage (diagnostic, no threshold)\n");
console.log("| | Lines | Statements | Functions | Branches |\n|---|---|---|---|---|");
console.log(`| **All of src/** | ${pct(total.lines)} | ${pct(total.statements)} | ${pct(total.functions)} | ${pct(total.branches)} |\n`);

const files = Object.entries(summary)
  .filter(([name]) => name !== "total" && /[\\/]src[\\/](core|application|infrastructure)[\\/]/.test(name))
  .map(([name, entry]) => ({ name: name.replace(/^.*[\\/]src[\\/]/, "src/"), lines: entry.lines.pct, branches: entry.branches.pct, uncovered: entry.lines.total - entry.lines.covered }))
  .filter((entry) => entry.uncovered > 0)
  .sort((a, b) => b.uncovered - a.uncovered)
  .slice(0, 10);

console.log("Core, application and infrastructure files with the most uncovered lines:\n");
console.log("| File | Uncovered lines | Lines | Branches |\n|---|---|---|---|");
for (const entry of files) console.log(`| ${entry.name} | ${entry.uncovered} | ${entry.lines}% | ${entry.branches}% |`);
