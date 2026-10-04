import { describe, expect, it } from "vitest";
import { boostExactMatches } from "../../src/core/rank-fusion.js";
import type { RetrievedChunk } from "../../src/core/retrieval.js";

function chunk(chunkId: string, content: string, fusedRank: number, fusedScore: number): RetrievedChunk {
  return { chunkId, documentId: "d", fileName: "f.md", chunkIndex: Number(chunkId.slice(1)), content, ranking: { fusedRank, fusedScore } };
}

const pool = () => [
  chunk("c1", "General notes about codes and batteries", 1, 0.03),
  chunk("c2", "E-4012 means the battery is low", 2, 0.0164),
  chunk("c3", "Another unrelated paragraph", 3, 0.01),
];

describe("boostExactMatches", () => {
  it("changes nothing without a bonus or without exact targets", () => {
    expect(boostExactMatches(pool(), ["E-4012"], 0)).toEqual(pool());
    expect(boostExactMatches(pool(), [], 0.02)).toEqual(pool());
  });

  it("lifts a chunk that contains the exact token above better ranked chunks and renumbers the ranks", () => {
    const boosted = boostExactMatches(pool(), ["E-4012"], 0.02);

    expect(boosted.map((item) => item.chunkId)).toEqual(["c2", "c1", "c3"]);
    expect(boosted.map((item) => item.ranking.fusedRank)).toEqual([1, 2, 3]);
    expect(boosted[0].ranking.fusedScore).toBeCloseTo(0.0364);
    expect(boosted[0].ranking.exactMatches).toBe(1);
  });

  it("adds the bonus once however many targets a chunk contains", () => {
    const boosted = boostExactMatches([chunk("c1", "E-4012 and E-4020 are battery and motor errors", 1, 0.01)], ["E-4012", "E-4020"], 0.02);

    expect(boosted[0].ranking.fusedScore).toBeCloseTo(0.03);
    expect(boosted[0].ranking.exactMatches).toBe(2);
  });

  it("does not reward a token that only appears inside a longer one", () => {
    const boosted = boostExactMatches([chunk("c1", "code E-40120 and XE-4012", 1, 0.01)], ["E-4012"], 0.02);

    expect(boosted[0].ranking.fusedScore).toBe(0.01);
    expect(boosted[0].ranking.exactMatches).toBeUndefined();
  });

  it("keeps the order of equal scores stable (best original rank first)", () => {
    const boosted = boostExactMatches(
      [chunk("c1", "ECONNRESET one", 1, 0.02), chunk("c2", "ECONNRESET two", 2, 0.02), chunk("c3", "plain", 3, 0.02)],
      ["ECONNRESET"],
      0.01,
    );

    expect(boosted.map((item) => item.chunkId)).toEqual(["c1", "c2", "c3"]);
  });

  it("does not mutate its input", () => {
    const input = pool();
    boostExactMatches(input, ["E-4012"], 0.02);

    expect(input).toEqual(pool());
  });

  it("rejects a negative bonus", () => {
    expect(() => boostExactMatches(pool(), ["E-4012"], -1)).toThrow(RangeError);
  });
});
