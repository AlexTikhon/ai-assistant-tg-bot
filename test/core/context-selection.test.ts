import { describe, expect, it } from "vitest";
import { selectContext } from "../../src/core/context-selection.js";
import type { RetrievedChunk } from "../../src/core/retrieval.js";

let counter = 0;
function chunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  counter += 1;
  return {
    chunkId: `c${counter}`,
    documentId: "d1",
    fileName: "d1.txt",
    chunkIndex: counter * 10, // far apart by default: never neighbours
    content: `unique content number ${counter} ${"x".repeat(50)}`,
    ranking: { fusedRank: counter, fusedScore: 1 / counter },
    ...overrides,
  };
}

const options = { maxChunks: 5, maxChars: 10_000, maxPerDocument: 5 };

describe("selectContext", () => {
  it("keeps relevance order and stops at maxChunks", () => {
    const candidates = [chunk(), chunk(), chunk(), chunk()];

    const { selected, skipped } = selectContext(candidates, { ...options, maxChunks: 2 });

    expect(selected.map((item) => item.chunkId)).toEqual([candidates[0].chunkId, candidates[1].chunkId]);
    expect(skipped).toEqual([]);
  });

  it("skips exact duplicates (e.g. the same file uploaded twice)", () => {
    const first = chunk({ documentId: "d1" });
    const copy = chunk({ documentId: "d2", content: first.content });

    const { selected, skipped } = selectContext([first, copy], options);

    expect(selected).toEqual([first]);
    expect(skipped).toEqual([{ chunkId: copy.chunkId, reason: "duplicate" }]);
  });

  it("skips a neighbouring chunk that mostly repeats an already selected one", () => {
    const base = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
    const first = chunk({ chunkIndex: 4, content: `${base} nu xi` });
    const neighbour = chunk({ chunkIndex: 5, content: `${base.slice(14)} nu xi omicron pi` });

    const { selected, skipped } = selectContext([first, neighbour], options);

    expect(selected).toEqual([first]);
    expect(skipped).toEqual([{ chunkId: neighbour.chunkId, reason: "overlap" }]);
  });

  it("keeps neighbouring chunks whose overlap is only the usual small boundary", () => {
    const first = chunk({ chunkIndex: 4, content: `${"a".repeat(30)} shared boundary text here ok` });
    const neighbour = chunk({ chunkIndex: 5, content: `shared boundary text here ok ${"b".repeat(60)}` });

    const { selected } = selectContext([first, neighbour], options);

    expect(selected).toHaveLength(2);
  });

  it("caps chunks per document but backfills free slots rather than wasting them", () => {
    const docA = [chunk({ documentId: "a" }), chunk({ documentId: "a" }), chunk({ documentId: "a" })];
    const docB = chunk({ documentId: "b" });

    const capped = selectContext([...docA, docB], { ...options, maxChunks: 3, maxPerDocument: 2 });
    expect(capped.selected.map((item) => item.chunkId)).toEqual([docA[0].chunkId, docA[1].chunkId, docB.chunkId]);

    const backfilled = selectContext(docA, { ...options, maxChunks: 3, maxPerDocument: 2 });
    expect(backfilled.selected).toHaveLength(3);
  });

  it("enforces the character budget by skipping what does not fit", () => {
    const big = chunk({ content: "b".repeat(600) });
    const small = chunk({ content: "s".repeat(100) });
    const huge = chunk({ content: "h".repeat(900) });

    const { selected, skipped } = selectContext([big, huge, small], { ...options, maxChars: 750 });

    expect(selected.map((item) => item.chunkId)).toEqual([big.chunkId, small.chunkId]);
    expect(skipped).toEqual([{ chunkId: huge.chunkId, reason: "budget" }]);
    expect(selected.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(750);
  });

  it("truncates the best chunk when it alone exceeds the budget, so there is always some context", () => {
    const { selected } = selectContext([chunk({ content: "w".repeat(2000) })], { ...options, maxChars: 500 });

    expect(selected).toHaveLength(1);
    expect(selected[0].content.length).toBeLessThanOrEqual(500);
  });

  it("returns nothing for no candidates", () => {
    expect(selectContext([], options)).toEqual({ selected: [], skipped: [] });
  });
});
