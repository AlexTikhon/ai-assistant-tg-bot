import { describe, expect, it } from "vitest";
import { formatProgress, formatReport, parseReindexArgs } from "../../src/cli/reindex-cli.js";
import type { ReindexReport } from "../../src/application/use-cases/run-reindex.use-case.js";

describe("parseReindexArgs", () => {
  it("defaults to re-indexing stale documents", () => {
    expect(parseReindexArgs([])).toEqual({ kind: "run", scope: { kind: "stale" }, dryRun: false });
  });

  it("supports --all, --document <id> and --dry-run", () => {
    expect(parseReindexArgs(["--all"])).toEqual({ kind: "run", scope: { kind: "all" }, dryRun: false });
    expect(parseReindexArgs(["--document", "abc-123"])).toEqual({
      kind: "run",
      scope: { kind: "document", documentId: "abc-123" },
      dryRun: false,
    });
    expect(parseReindexArgs(["--dry-run", "--all"])).toEqual({ kind: "run", scope: { kind: "all" }, dryRun: true });
  });

  it("shows help", () => {
    expect(parseReindexArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("rejects conflicting, incomplete and unknown arguments with a readable message", () => {
    expect(parseReindexArgs(["--all", "--document", "x"])).toMatchObject({ kind: "error", message: expect.stringMatching(/together/) });
    expect(parseReindexArgs(["--document"])).toMatchObject({ kind: "error" });
    expect(parseReindexArgs(["--bogus"])).toMatchObject({ kind: "error", message: expect.stringContaining("--bogus") });
    expect(parseReindexArgs(["stray"])).toMatchObject({ kind: "error" });
  });
});

const report = (overrides: Partial<ReindexReport> = {}): ReindexReport => ({
  model: "text-embedding-3-small",
  documents: 3,
  chunks: 30,
  succeeded: 2,
  chunksReindexed: 20,
  failed: [{ documentId: "d3", fileName: "c.pdf", reason: "The AI service is temporarily unavailable." }],
  dryRun: false,
  ...overrides,
});

describe("reindex output", () => {
  it("formats one progress line per document", () => {
    expect(
      formatProgress({ position: 2, total: 5, documentId: "d2", fileName: "b.md", outcome: "reindexed", chunks: 12 }),
    ).toBe("[2/5] re-indexed b.md (d2): 12 chunks");
    expect(
      formatProgress({ position: 3, total: 5, documentId: "d3", fileName: "c.pdf", outcome: "failed", chunks: 0, reason: "boom" }),
    ).toBe("[3/5] FAILED c.pdf (d3): boom");
    expect(
      formatProgress({ position: 1, total: 1, documentId: "d1", fileName: "a.txt", outcome: "planned", chunks: 4 }),
    ).toBe("[1/1] would re-index a.txt (d1): 4 chunks");
  });

  it("summarizes a run including failures and how to retry", () => {
    const text = formatReport(report());

    expect(text).toContain("2 of 3 documents re-indexed (20 chunks) with text-embedding-3-small");
    expect(text).toContain("1 failed");
    expect(text).toContain("c.pdf (d3)");
    expect(text).toContain("npm run reindex");
  });

  it("says when there is nothing to do and when it was only a dry run", () => {
    expect(formatReport(report({ documents: 0, chunks: 0, succeeded: 0, chunksReindexed: 0, failed: [] }))).toContain(
      "Nothing to re-index",
    );
    expect(formatReport(report({ dryRun: true, succeeded: 0, chunksReindexed: 0, failed: [] }))).toContain(
      "Dry run: 3 documents (30 chunks) would be re-indexed",
    );
  });
});
