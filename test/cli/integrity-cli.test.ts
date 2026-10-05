import { describe, expect, it } from "vitest";
import type { IntegrityReport } from "../../src/application/use-cases/inspect-integrity.use-case.js";
import type { RepairResult } from "../../src/application/use-cases/repair-integrity.use-case.js";
import { formatIntegrityReport, formatRepairResult, INTEGRITY_USAGE, parseIntegrityArgs } from "../../src/cli/integrity-cli.js";

const summary = { documents: 3, chunks: 40, errors: 0, warnings: 0, needsReembed: 0, needsRechunk: 0, chunksToEmbed: 0 };
const report = (issues: IntegrityReport["issues"] = [], overrides: Partial<IntegrityReport["summary"]> = {}): IntegrityReport => ({
  issues,
  summary: { ...summary, errors: issues.filter((i) => i.severity === "error").length, warnings: issues.filter((i) => i.severity === "warning").length, ...overrides },
});

describe("parseIntegrityArgs", () => {
  it("defaults to a read-only check", () => {
    expect(parseIntegrityArgs([])).toEqual({ kind: "run", repair: false, removeOrphans: false, verifyHashes: true, json: false });
  });

  it("--repair enables the safe repairs, --skip-hashes the fast mode, --json machine output", () => {
    expect(parseIntegrityArgs(["--repair", "--skip-hashes", "--json"])).toEqual({ kind: "run", repair: true, removeOrphans: false, verifyHashes: false, json: true });
  });

  it("deleting orphan files is a separate decision that requires --repair", () => {
    expect(parseIntegrityArgs(["--repair", "--remove-orphans"])).toMatchObject({ kind: "run", repair: true, removeOrphans: true });
    expect(parseIntegrityArgs(["--remove-orphans"])).toMatchObject({ kind: "error", message: expect.stringContaining("--repair") });
  });

  it("help and unknown options", () => {
    expect(parseIntegrityArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseIntegrityArgs(["--fix-everything"]).kind).toBe("error");
    expect(INTEGRITY_USAGE).toMatch(/read-only/i);
    expect(INTEGRITY_USAGE).toMatch(/never/i);
  });
});

describe("formatIntegrityReport", () => {
  it("says plainly when everything is fine", () => {
    expect(formatIntegrityReport(report())).toContain("No problems found");
  });

  it("lists errors before warnings with the fix next to each problem and a result line", () => {
    const text = formatIntegrityReport(
      report([
        { code: "stale-index", severity: "warning", message: "a.txt is stale", documentId: "d1", fileName: "a.txt", remedy: "npm run reindex" },
        { code: "missing-file", severity: "error", message: "b.txt lost its file", documentId: "d2", fileName: "b.txt", remedy: "Restore it" },
      ]),
    );

    expect(text.indexOf("ERRORS")).toBeLessThan(text.indexOf("WARNINGS"));
    expect(text).toContain("[missing-file] b.txt lost its file");
    expect(text).toContain("fix: Restore it");
    expect(text).toContain("fix: npm run reindex");
    expect(text).toMatch(/1 error, 1 warning/);
  });

  it("names which command each stale document needs, and how many chunks that would embed", () => {
    const text = formatIntegrityReport(report([], { needsReembed: 2, needsRechunk: 1, chunksToEmbed: 30, warnings: 3 }));

    expect(text).toContain("2 documents need re-embedding: npm run reindex");
    expect(text).toContain("1 document needs re-chunking: npm run reindex -- --rechunk");
    expect(text).toContain("30 chunks");
    expect(text).toMatch(/--dry-run/);
  });

  it("never prints secrets or file contents: only names, ids and counts", () => {
    const text = formatIntegrityReport(report([{ code: "missing-file", severity: "error", message: "x", documentId: "d", fileName: "f.txt" }]));

    expect(text).not.toMatch(/sk-|token|password/i);
  });
});

describe("formatRepairResult", () => {
  const after = report();

  it("prints exactly what was changed", () => {
    const result: RepairResult = {
      actions: [
        { kind: "rebuilt-full-text-index", verified: { chunks: 12, searchesChecked: 12, contentCheck: "compared" } },
        { kind: "backfilled-content-hash", documentId: "d1", fileName: "a.txt" },
        { kind: "removed-temporary-file", file: ".tmp-1.part" },
        { kind: "removed-orphan-file", file: "stray.txt" },
        { kind: "failed", step: "remove temporary file x", reason: "EPERM" },
      ],
      after,
    };

    const text = formatRepairResult(result);

    expect(text).toContain("rebuilt the full-text index and verified it (12 chunks indexed, 12 sample searches ok, content compared with the chunk text)");
    expect(text).toContain("recorded the content hash of a.txt (d1)");
    expect(text).toContain("removed temporary file .tmp-1.part");
    expect(text).toContain("removed orphan file stray.txt");
    expect(text).toContain("FAILED remove temporary file x: EPERM");
  });

  it("says so when there was nothing safe to repair, and states what repair never does", () => {
    const text = formatRepairResult({ actions: [], after });

    expect(text).toContain("Nothing was repaired");
    expect(text).toMatch(/embeddings|OpenAI/);
  });
});
