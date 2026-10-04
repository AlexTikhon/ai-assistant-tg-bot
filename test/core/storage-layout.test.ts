import { describe, expect, it } from "vitest";
import { classifyStorage, DEFAULT_STORAGE_AGE_LIMITS } from "../../src/core/storage-layout.js";
import type { StorageEntry } from "../../src/core/storage-layout.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-03-01T12:00:00.000Z");

const entry = (name: string, kind: StorageEntry["kind"], ageMs: number, size = 10): StorageEntry => ({
  name,
  kind,
  size,
  modifiedAtMs: NOW - ageMs,
});

describe("classifyStorage (fake clock)", () => {
  it("separates referenced files, temporary files and orphans", () => {
    const layout = classifyStorage(
      [entry("a.txt", "stored", 5 * HOUR), entry("b.txt", "stored", 5 * HOUR), entry("x.part", "temporary", 5 * HOUR)],
      new Set(["a.txt"]),
      NOW,
    );

    expect(layout.referenced.map((item) => item.name)).toEqual(["a.txt"]);
    expect(layout.orphans.map((item) => item.entry.name)).toEqual(["b.txt"]);
    expect(layout.temporary.map((item) => item.entry.name)).toEqual(["x.part"]);
  });

  it("only calls a temporary file stale once it is older than the limit, so an active write is never removed", () => {
    const limit = DEFAULT_STORAGE_AGE_LIMITS.temporaryMs;
    const layout = classifyStorage(
      [entry("fresh.part", "temporary", limit - 1), entry("exactly.part", "temporary", limit), entry("old.part", "temporary", limit + 1)],
      new Set(),
      NOW,
    );

    expect(layout.temporary.map((item) => [item.entry.name, item.stale])).toEqual([
      ["fresh.part", false],
      ["exactly.part", true],
      ["old.part", true],
    ]);
  });

  it("only calls an orphan removable after the longer orphan limit: a file saved a moment before its row is committed is not an orphan yet", () => {
    const limit = DEFAULT_STORAGE_AGE_LIMITS.orphanMs;
    const layout = classifyStorage(
      [entry("new.txt", "stored", 1000), entry("old.txt", "stored", limit)],
      new Set(),
      NOW,
    );

    expect(layout.orphans.map((item) => [item.entry.name, item.removable])).toEqual([
      ["new.txt", false],
      ["old.txt", true],
    ]);
  });

  it("the age limits can be overridden", () => {
    const layout = classifyStorage([entry("t.part", "temporary", 10)], new Set(), NOW, { temporaryMs: 5, orphanMs: 5 });

    expect(layout.temporary[0].stale).toBe(true);
  });

  it("a clock that is behind the file's timestamp gives an age of zero, never a negative one", () => {
    const layout = classifyStorage([entry("future.part", "temporary", -HOUR)], new Set(), NOW);

    expect(layout.temporary[0]).toMatchObject({ ageMs: 0, stale: false });
  });

  it("lists referenced names that have no file as missing", () => {
    const layout = classifyStorage([entry("a.txt", "stored", HOUR)], new Set(["a.txt", "gone.txt"]), NOW);

    expect(layout.missing).toEqual(["gone.txt"]);
  });
});
