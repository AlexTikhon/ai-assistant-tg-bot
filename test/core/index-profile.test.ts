import { describe, expect, it } from "vitest";
import {
  buildIndexProfile,
  CHUNKING_ALGORITHM_VERSION,
  describeStaleness,
  diffIndexProfiles,
  extractorVersionFor,
  indexFingerprint,
  LEGACY_PDF_EXTRACTOR_VERSION,
  TEXT_EXTRACTOR_VERSION,
} from "../../src/core/index-profile.js";
import type { StoredIndexProfile } from "../../src/core/index-profile.js";

const active = (overrides: Partial<Parameters<typeof buildIndexProfile>[0]> = {}) =>
  buildIndexProfile({
    fileName: "notes.md",
    embeddingModel: "text-embedding-3-small",
    embeddingDimension: 1536,
    chunkSize: 1000,
    chunkOverlap: 150,
    ...overrides,
  });

describe("index fingerprint", () => {
  it("is deterministic and independent of key order", () => {
    const profile = active();
    const reordered = Object.fromEntries(Object.entries(profile).reverse()) as typeof profile;

    expect(indexFingerprint(profile)).toBe(indexFingerprint({ ...profile }));
    expect(indexFingerprint(reordered)).toBe(indexFingerprint(profile));
    expect(indexFingerprint(profile)).toMatch(/^[0-9a-f]{12}$/);
  });

  it.each([
    ["embedding model", { embeddingModel: "text-embedding-3-large" }],
    ["embedding dimension", { embeddingDimension: 3072 }],
    ["chunk size", { chunkSize: 900 }],
    ["chunk overlap", { chunkOverlap: 100 }],
    ["extractor (file type)", { fileName: "notes.pdf" }],
  ])("changes when the %s changes", (_label, change) => {
    expect(indexFingerprint(active(change))).not.toBe(indexFingerprint(active()));
  });

  it("changes with the chunking algorithm version and distinguishes unknown from a number", () => {
    const profile = active();

    expect(indexFingerprint({ ...profile, chunkingVersion: CHUNKING_ALGORITHM_VERSION + 1 })).not.toBe(
      indexFingerprint(profile),
    );
    expect(indexFingerprint({ ...profile, chunkSize: null })).not.toBe(indexFingerprint({ ...profile, chunkSize: 0 }));
  });

  it("covers exactly the persisted index data - retrieval settings are not part of the profile", () => {
    expect(Object.keys(active()).sort()).toEqual(
      ["chunkOverlap", "chunkSize", "chunkingVersion", "embeddingDimension", "embeddingModel", "extractorVersion"].sort(),
    );
  });
});

describe("extractor versions", () => {
  it("are per file type, so a PDF extraction change does not touch text documents", () => {
    expect(extractorVersionFor("a.md")).toBe(TEXT_EXTRACTOR_VERSION);
    expect(extractorVersionFor("a.TXT")).toBe(TEXT_EXTRACTOR_VERSION);
    expect(extractorVersionFor("a.pdf")).not.toBe(LEGACY_PDF_EXTRACTOR_VERSION);
    expect(extractorVersionFor("A.PDF")).toBe(extractorVersionFor("a.pdf"));
  });
});

describe("diffIndexProfiles", () => {
  it("reports an unchanged profile as current", () => {
    expect(diffIndexProfiles(active(), active())).toEqual([]);
  });

  it("marks a chunk size change as chunking-stale, with the values", () => {
    expect(diffIndexProfiles(active({ chunkSize: 1200 }), active({ chunkSize: 900 }))).toEqual([
      { kind: "chunking", field: "chunkSize", from: 1200, to: 900 },
    ]);
  });

  it("marks an overlap change as chunking-stale", () => {
    expect(diffIndexProfiles(active({ chunkOverlap: 150 }), active({ chunkOverlap: 50 }))).toEqual([
      { kind: "chunking", field: "chunkOverlap", from: 150, to: 50 },
    ]);
  });

  it("marks an embedding model change as embedding-stale", () => {
    expect(
      diffIndexProfiles(active(), active({ embeddingModel: "text-embedding-3-large", embeddingDimension: 3072 })).map(
        (reason) => [reason.kind, reason.field],
      ),
    ).toEqual([
      ["embedding", "embeddingModel"],
      ["embedding", "embeddingDimension"],
    ]);
  });

  it("keeps the three staleness kinds apart", () => {
    const stored: StoredIndexProfile = {
      ...active({ fileName: "a.pdf", chunkSize: 1200 }),
      chunkingVersion: CHUNKING_ALGORITHM_VERSION - 1,
      extractorVersion: LEGACY_PDF_EXTRACTOR_VERSION,
      embeddingModel: "old",
    };
    const reasons = diffIndexProfiles(stored, active({ fileName: "a.pdf", chunkSize: 900 }));

    expect(describeStaleness(reasons)).toEqual({ embedding: true, chunking: true, extractor: true });
    expect(describeStaleness([])).toEqual({ embedding: false, chunking: false, extractor: false });
    expect(describeStaleness(diffIndexProfiles(active({ chunkSize: 1200 }), active()))).toEqual({
      embedding: false,
      chunking: true,
      extractor: false,
    });
  });

  it("cannot judge fields that were never recorded (legacy documents), and does not invent differences", () => {
    const legacy: StoredIndexProfile = { ...active(), chunkSize: null, chunkOverlap: null };

    expect(diffIndexProfiles(legacy, active())).toEqual([]);
  });

  it("skips the dimension when the active one is not known yet (dry run without a provider call)", () => {
    const unknownDimension = { ...active(), embeddingDimension: undefined };

    expect(diffIndexProfiles(active({ embeddingDimension: 3072 }), unknownDimension)).toEqual([]);
  });
});
