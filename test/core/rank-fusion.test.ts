import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "../../src/core/rank-fusion.js";
import type { ChunkMatch } from "../../src/core/retrieval.js";

const match = (chunkId: string, score = 1, documentId = "d", chunkIndex = 0): ChunkMatch => ({
  chunkId,
  documentId,
  chunkIndex,
  score,
});

describe("reciprocalRankFusion", () => {
  it("scores 1/(k+rank) per list and sums them", () => {
    const [top] = reciprocalRankFusion([match("a")], [match("a")], 60);

    expect(top.fusedScore).toBeCloseTo(2 / 61);
    expect(top).toMatchObject({ chunkId: "a", semanticRank: 1, lexicalRank: 1, fusedRank: 1 });
  });

  it("merges duplicates by chunk id and ranks chunks found by both lists first", () => {
    const fused = reciprocalRankFusion([match("a"), match("b")], [match("b"), match("c")]);

    expect(fused.map((item) => item.chunkId)).toEqual(["b", "a", "c"]);
    expect(fused.map((item) => item.fusedRank)).toEqual([1, 2, 3]);
    expect(fused.find((item) => item.chunkId === "b")).toMatchObject({ semanticRank: 2, lexicalRank: 1 });
  });

  it("keeps candidates that appear in only one list", () => {
    const fused = reciprocalRankFusion([match("a")], [match("b")]);

    expect(fused.find((item) => item.chunkId === "a")).toMatchObject({ semanticRank: 1 });
    expect(fused.find((item) => item.chunkId === "a")?.lexicalRank).toBeUndefined();
    expect(fused.find((item) => item.chunkId === "b")?.semanticRank).toBeUndefined();
  });

  it("ignores raw scores: only the rank inside each list matters", () => {
    const fused = reciprocalRankFusion([match("a", 0.99), match("b", 0.98)], [match("b", -0.000001), match("a", -50)]);

    // a: 1/61 + 1/62, b: 1/62 + 1/61 -> an exact tie, whatever the raw scores say
    expect(fused).toHaveLength(2);
    expect(fused[0].fusedScore).toBeCloseTo(fused[1].fusedScore);
  });

  it("breaks ties deterministically by document and chunk position", () => {
    const first = reciprocalRankFusion([match("x", 1, "d2", 0)], [match("y", 1, "d1", 0)]);
    const second = reciprocalRankFusion([match("x", 1, "d2", 0)], [match("y", 1, "d1", 0)]);

    expect(first.map((item) => item.chunkId)).toEqual(second.map((item) => item.chunkId));
    expect(first.map((item) => item.chunkId)).toEqual(["y", "x"]);
  });

  it("uses the first (best) occurrence when a list repeats a chunk", () => {
    const fused = reciprocalRankFusion([match("a"), match("a")], []);

    expect(fused).toHaveLength(1);
    expect(fused[0].semanticRank).toBe(1);
  });

  it("returns an empty list for empty input and rejects a non-positive k", () => {
    expect(reciprocalRankFusion([], [])).toEqual([]);
    expect(() => reciprocalRankFusion([], [], 0)).toThrow(RangeError);
  });

  it("keeps the original semantic score for explanation", () => {
    const [item] = reciprocalRankFusion([match("a", 0.83)], []);

    expect(item.semanticScore).toBe(0.83);
  });
});
