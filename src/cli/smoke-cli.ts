import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Creating the fixture installation indexes a document through the real application, which logs; this command prints its own report only.
process.env.LOG_LEVEL ??= "silent";

const { createCore } = await import("../composition-root.js");
const { loadCoreConfig } = await import("../config/config.js");
const { createOfflineProviders } = await import("./smoke-providers.js");

/**
 * `npm run smoke:cli`: do the operational commands work from the COMPILED build, in a process of their own, without credentials?
 *
 * It creates a small installation in a temporary directory (the real core around offline providers), then runs the real command files
 * next to this one - diagnostics, integrity, backup, backup:verify, restore (dry run, real, and refused), db:maintenance, reindex
 * --dry-run - as child processes with no API key and no bot token in their environment, and checks their exit codes and output.
 * It is the check that the packaged operational tools resolve their imports and behave, which a run through tsx cannot show.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "tg-rag-cli-"));
const results: string[] = [];
let failed = false;

const baseEnv = (dataDir: string): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: "silent", OPENAI_EMBEDDINGS_MODEL: "smoke-hashed-v1", CHUNK_SIZE: "300", CHUNK_OVERLAP: "40" };
  delete env.OPENAI_API_KEY;
  delete env.TELEGRAM_BOT_TOKEN;
  return env;
};

function run(name: string, script: string, args: string[], dataDir: string, expectation: { exitCode: number; output: RegExp }) {
  const child = spawnSync(process.execPath, [path.join(here, script), ...args], { env: baseEnv(dataDir), encoding: "utf-8", cwd: root });
  const output = `${child.stdout}${child.stderr}`;
  const ok = child.status === expectation.exitCode && expectation.output.test(output);
  results.push(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed = true;
    results.push(`     expected exit ${expectation.exitCode} and ${expectation.output}; got exit ${child.status}:\n${output.split("\n").map((line) => `     | ${line}`).join("\n")}`);
  }
}

try {
  const live = path.join(root, "live");
  const config = loadCoreConfig(baseEnv(live));
  const core = createCore(config, createOfflineProviders());
  await core.useCases.ingestDocument.execute({ userId: "cli-check", fileName: "handbook.md", mimeType: "text/markdown", data: Buffer.from("# Handbook\n\n## Backups\nThe nightly backup runs at 02:00 UTC.\n") });
  core.close();

  const backup = path.join(root, "backup");
  const restored = path.join(root, "restored");
  run("diagnostics", "diagnostics.js", [], live, { exitCode: 0, output: /Schema {10}version \d+ \(this application expects \d+\)[\s\S]*1 documents/ });
  run("diagnostics --json", "diagnostics.js", ["--json"], live, { exitCode: 0, output: /"fts5Compiled": true/ });
  run("integrity", "integrity.js", [], live, { exitCode: 0, output: /No problems found/ });
  run("db:maintenance", "db-maintenance.js", [], live, { exitCode: 0, output: /Integrity check: ok/ });
  run("db:maintenance --checkpoint --optimize", "db-maintenance.js", ["--checkpoint", "--optimize"], live, { exitCode: 0, output: /WAL checkpoint[\s\S]*optimize/ });
  run("reindex --dry-run", "reindex.js", ["--dry-run"], live, { exitCode: 0, output: /./ });
  run("backup", "backup.js", ["--output", backup], live, { exitCode: 0, output: /Backup written to/ });
  run("backup:verify", "backup-verify.js", [backup], live, { exitCode: 0, output: /Backup OK/ });
  run("restore --dry-run", "restore.js", ["--from", backup, "--target", restored, "--dry-run"], live, { exitCode: 0, output: /Dry run: the backup can be restored/ });
  run("restore", "restore.js", ["--from", backup, "--target", restored], live, { exitCode: 0, output: /Restored 1 document/ });
  run("restore refuses a populated target", "restore.js", ["--from", backup, "--target", restored], live, { exitCode: 1, output: /--replace-existing/ });
  run("integrity (restored)", "integrity.js", [], restored, { exitCode: 0, output: /No problems found/ });
  run("restore --replace-existing", "restore.js", ["--from", backup, "--target", restored, "--replace-existing"], live, { exitCode: 0, output: /Restored 1 document[\s\S]*was kept in \.restore-previous-/ });
  run("restore of a missing backup", "restore.js", ["--from", path.join(root, "nope")], live, { exitCode: 1, output: /did not pass verification/ });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log(failed ? "\nCLI check FAILED." : `\nCLI check passed: ${results.length} commands behaved as documented, from compiled code, without credentials.`);
process.exitCode = failed ? 1 : 0;
