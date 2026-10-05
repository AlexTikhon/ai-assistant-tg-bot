import { describe, expect, it } from "vitest";
import type { ChunkMatch } from "../../src/core/retrieval.js";
import { compareMatches, TopMatches } from "../../src/core/top-matches.js";

describe("bounded top-K selection", () => {
  it.each([0, 1, 5, 20, 500])("matches a full-sort oracle at limit %i, including score ties", (limit) => {
    const candidates: ChunkMatch[] = Array.from({ length: 300 }, (_, i) => ({
      chunkId: `chunk-${i}`, documentId: `doc-${i % 13}`, chunkIndex: i,
      score: ((i * 37) % 19) / 19,
    }));
    for (const order of [candidates, [...candidates].reverse()]) {
      const top = new TopMatches(limit);
      for (const candidate of order) top.add(candidate);
      expect(top.sorted()).toEqual([...candidates].sort(compareMatches).slice(0, limit));
    }
  });
});
