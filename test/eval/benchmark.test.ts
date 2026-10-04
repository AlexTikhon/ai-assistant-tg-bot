import { describe, expect, it } from "vitest";
import { formatBenchmark, generateChunks, percentile, runBenchmark } from "../../src/eval/benchmark.js";

describe("generateChunks", () => {
  const options = { count: 60, dimension: 8, users: 3, chunksPerDocument: 10, seed: 42 };

  it("is deterministic: the same seed always produces the same data", () => {
    expect(generateChunks(options)).toEqual(generateChunks(options));
    expect(generateChunks({ ...options, seed: 43 })).not.toEqual(generateChunks(options));
  });

  it("produces unit-length finite vectors of the requested dimension and readable text", () => {
    const chunks = generateChunks(options);

    expect(chunks).toHaveLength(60);
    for (const chunk of chunks) {
      expect(chunk.embedding).toHaveLength(8);
      expect(Math.hypot(...chunk.embedding)).toBeCloseTo(1, 5);
      expect(chunk.content.split(" ").length).toBeGreaterThan(20);
    }
  });

  it("spreads chunks over users and documents, and keeps chunk positions unique within a document", () => {
    const chunks = generateChunks(options);

    expect(new Set(chunks.map((chunk) => chunk.userId))).toEqual(new Set(["user-0", "user-1", "user-2"]));
    const positions = chunks.map((chunk) => `${chunk.documentId}#${chunk.chunkIndex}`);
    expect(new Set(positions).size).toBe(chunks.length);
  });

  it("uses a skewed vocabulary, so some words are common and most are rare, like real text", () => {
    const words = generateChunks({ ...options, count: 200 }).flatMap((chunk) => chunk.content.split(" "));
    const counts = new Map<string, number>();
    words.forEach((word) => counts.set(word, (counts.get(word) ?? 0) + 1));
    const sorted = [...counts.values()].sort((a, b) => b - a);

    expect(sorted[0]).toBeGreaterThan(sorted[Math.floor(sorted.length / 2)] * 10);
  });
});

describe("percentile", () => {
  it("returns the median and the high percentiles of a list of timings", () => {
    const values = [5, 1, 3, 2, 4];

    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 100)).toBe(5);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe("runBenchmark", () => {
  it("measures every stage for every size and reports them in a table", async () => {
    const results = await runBenchmark({ sizes: [40, 80], dimension: 8, users: 2, runs: 3, warmup: 1, seed: 1 });

    expect(results.map((result) => result.chunks)).toEqual([40, 80]);
    for (const result of results) {
      expect(result.stages.map((stage) => stage.name)).toEqual([
        "semantic scan",
        "FTS (rare terms)",
        "FTS (common terms)",
        "RRF fusion",
        "context selection",
      ]);
      for (const stage of result.stages) {
        expect(stage.medianMs).toBeGreaterThanOrEqual(0);
        expect(stage.p95Ms).toBeGreaterThanOrEqual(stage.medianMs);
      }
      expect(result.userChunks).toBeLessThan(result.chunks);
    }

    const table = formatBenchmark(results, { dimension: 8, users: 2, runs: 3 });
    expect(table).toContain("semantic scan");
    expect(table).toContain("40");
    expect(table).toContain("80");
    expect(table).toMatch(/median/i);
  });
});
