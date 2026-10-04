import { describe, expect, it } from "vitest";
import { formatProgress, formatReport, parseReindexArgs } from "../../src/cli/reindex-cli.js";
import type { ReindexReport } from "../../src/application/use-cases/run-reindex.use-case.js";

describe("parseReindexArgs", () => {
  const run = (overrides = {}) => ({ kind: "run", scope: { kind: "stale" }, dryRun: false, rechunk: false, ...overrides });

  it("defaults to re-indexing documents with outdated embeddings", () => {
    expect(parseReindexArgs([])).toEqual(run());
  });

  it("supports --all, --document <id>, --dry-run and --rechunk", () => {
    expect(parseReindexArgs(["--all"])).toEqual(run({ scope: { kind: "all" } }));
    expect(parseReindexArgs(["--document", "abc-123"])).toEqual(run({ scope: { kind: "document", documentId: "abc-123" } }));
    expect(parseReindexArgs(["--dry-run", "--all"])).toEqual(run({ scope: { kind: "all" }, dryRun: true }));
    expect(parseReindexArgs(["--all", "--rechunk"])).toEqual(run({ scope: { kind: "all" }, rechunk: true }));
    expect(parseReindexArgs(["--rechunk", "--dry-run"])).toEqual(run({ rechunk: true, dryRun: true }));
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
  reembedded: 1,
  rechunked: 1,
  failed: [{ documentId: "d3", fileName: "c.pdf", reason: "The AI service is temporarily unavailable." }],
  dryRun: false,
  summary: { checked: 3, embedding: 1, chunking: 1, extractor: 0, unknownChunkLayout: 0 },
  stale: [],
  ...overrides,
});

describe("reindex output", () => {
  const base = { position: 2, total: 5, documentId: "d2", fileName: "b.md", reasons: [] };

  it("formats one progress line per document, saying what was done", () => {
    expect(formatProgress({ ...base, outcome: "reindexed", action: "reembed", chunks: 12 })).toBe(
      "[2/5] re-embedded b.md (d2): 12 chunks",
    );
    expect(formatProgress({ ...base, outcome: "reindexed", action: "rechunk", chunks: 7 })).toBe(
      "[2/5] re-chunked b.md (d2): 7 chunks",
    );
    expect(formatProgress({ ...base, outcome: "failed", action: "rechunk", chunks: 0, reason: "boom" })).toBe(
      "[2/5] FAILED re-chunking b.md (d2): boom",
    );
    expect(formatProgress({ ...base, outcome: "planned", action: "reembed", chunks: 4 })).toBe(
      "[2/5] would re-embed b.md (d2): 4 chunks",
    );
  });

  it("summarizes a run including failures and how to retry", () => {
    const text = formatReport(report());

    expect(text).toContain("2 of 3 documents re-indexed (20 chunks) with text-embedding-3-small");
    expect(text).toContain("1 re-embedded, 1 re-chunked");
    expect(text).toContain("1 failed");
    expect(text).toContain("c.pdf (d3)");
    expect(text).toContain("npm run reindex");
  });

  it("says when there is nothing to do", () => {
    const text = formatReport(report({ documents: 0, chunks: 0, succeeded: 0, chunksReindexed: 0, failed: [] }));

    expect(text).toContain("Nothing to re-index");
  });

  it("tells the operator about stale documents this run leaves alone", () => {
    const text = formatReport(
      report({
        documents: 0,
        chunks: 0,
        succeeded: 0,
        failed: [],
        stale: [
          {
            documentId: "d1",
            fileName: "a.md",
            reasons: [{ kind: "chunking", field: "chunkSize", from: 1200, to: 900 }],
            action: null,
          },
        ],
      }),
    );

    expect(text).toContain("1 stale document was not changed");
    expect(text).toContain("--rechunk");
  });

  describe("dry run", () => {
    const dryRun = report({
      dryRun: true,
      summary: { checked: 12, embedding: 1, chunking: 1, extractor: 0, unknownChunkLayout: 0 },
      stale: [
        {
          documentId: "d1",
          fileName: "notes.pdf",
          reasons: [
            { kind: "embedding", field: "embeddingModel", from: "text-embedding-3-small", to: "text-embedding-3-large" },
          ],
          action: "reembed",
        },
        {
          documentId: "d2",
          fileName: "architecture.pdf",
          reasons: [
            { kind: "chunking", field: "chunkSize", from: 1200, to: 900 },
            { kind: "chunking", field: "chunkingVersion", from: 1, to: 2 },
          ],
          action: null,
        },
      ],
    });

    it("explains for every stale document what differs", () => {
      const text = formatReport(dryRun);

      expect(text).toContain(
        ["notes.pdf (d1)", "  embedding model:", "    text-embedding-3-small -> text-embedding-3-large"].join("\n"),
      );
      expect(text).toContain(
        ["architecture.pdf (d2)", "  chunk size:", "    1200 -> 900", "  chunking version:", "    v1 -> v2"].join("\n"),
      );
    });

    it("says what the run would do per document, and what it would leave alone", () => {
      const text = formatReport(dryRun);

      expect(text).toContain("would re-embed");
      expect(text).toContain("not changed by this run (add --rechunk)");
    });

    it("ends with a summary of how many documents are stale in which way", () => {
      const text = formatReport(dryRun);

      expect(text).toContain(
        ["Summary:", "12 documents checked", "1 stale embedding", "1 stale chunk layout", "0 extraction-version changes"].join("\n"),
      );
      expect(text).toContain("Dry run: 3 documents (30 chunks) would be re-indexed");
    });

    it("mentions documents whose chunk layout was never recorded", () => {
      const text = formatReport({ ...dryRun, summary: { ...dryRun.summary, unknownChunkLayout: 4 } });

      expect(text).toContain("4 documents with an unrecorded chunk layout (indexed before recipes were tracked)");
    });
  });
});
