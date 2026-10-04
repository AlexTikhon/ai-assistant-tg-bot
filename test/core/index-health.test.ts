import { describe, expect, it } from "vitest";
import { deriveIndexHealth, isSearchable } from "../../src/core/index-health.js";
import type { HealthFacts } from "../../src/core/index-health.js";

const healthy: HealthFacts = {
  chunkCount: 5,
  unreadableChunkCount: 0,
  stale: { embedding: false, chunking: false, extractor: false },
  fileMissing: false,
};

describe("deriveIndexHealth", () => {
  it("is current when nothing is wrong", () => {
    expect(deriveIndexHealth(healthy)).toEqual({ state: "current", issues: [] });
  });

  it("is unindexed without any chunk", () => {
    expect(deriveIndexHealth({ ...healthy, chunkCount: 0 })).toEqual({ state: "unindexed", issues: ["unindexed"] });
  });

  it("is corrupt-index when stored vectors cannot be read", () => {
    expect(deriveIndexHealth({ ...healthy, unreadableChunkCount: 2 }).state).toBe("corrupt-index");
  });

  it.each([
    ["embedding", "embedding-stale"],
    ["chunking", "chunking-stale"],
    ["extractor", "extractor-stale"],
  ] as const)("reports a %s difference as %s", (kind, state) => {
    expect(deriveIndexHealth({ ...healthy, stale: { ...healthy.stale, [kind]: true } })).toEqual({ state, issues: [state] });
  });

  it("reports a missing original file, and treats an unknown file state as no problem", () => {
    expect(deriveIndexHealth({ ...healthy, fileMissing: true })).toEqual({ state: "missing-file", issues: ["missing-file"] });
    expect(deriveIndexHealth({ ...healthy, fileMissing: null }).state).toBe("current");
  });

  it("lists every problem, most serious first, and names the first one as the state", () => {
    const health = deriveIndexHealth({
      chunkCount: 3,
      unreadableChunkCount: 1,
      stale: { embedding: true, chunking: true, extractor: true },
      fileMissing: true,
    });

    expect(health.issues).toEqual(["corrupt-index", "embedding-stale", "chunking-stale", "extractor-stale", "missing-file"]);
    expect(health.state).toBe("corrupt-index");
  });

  it("does not count stale-ness of a document without chunks: there is nothing to be stale", () => {
    expect(deriveIndexHealth({ ...healthy, chunkCount: 0, stale: { embedding: true, chunking: true, extractor: true } }).issues).toEqual(["unindexed"]);
  });
});

describe("isSearchable", () => {
  it("everything except an index with no chunks can still be searched (keyword search at least)", () => {
    expect(isSearchable(deriveIndexHealth(healthy))).toBe(true);
    expect(isSearchable(deriveIndexHealth({ ...healthy, fileMissing: true }))).toBe(true);
    expect(isSearchable(deriveIndexHealth({ ...healthy, stale: { ...healthy.stale, embedding: true } }))).toBe(true);
    expect(isSearchable(deriveIndexHealth({ ...healthy, unreadableChunkCount: 1 }))).toBe(true);
    expect(isSearchable(deriveIndexHealth({ ...healthy, chunkCount: 0 }))).toBe(false);
  });
});
