/**
 * What lives in the file storage, and how to tell the three kinds apart:
 *
 * - referenced: a committed file that a document row points to (what the bot needs),
 * - temporary: a half-written upload in the temporary area (an interrupted write leaves one),
 * - orphan: a committed file that no document row points to (an interrupted ingestion, a failed cleanup).
 *
 * Age protects work in flight: an ingestion writes its file shortly *before* its row is committed, and a
 * running write owns a temporary file. Only entries older than a limit are ever candidates for removal.
 */
export type StorageEntry = {
  name: string;
  kind: "stored" | "temporary";
  size: number;
  /** Last modification, epoch milliseconds. */
  modifiedAtMs: number;
};

export type StorageAgeLimits = {
  /** A temporary file older than this is a leftover of an interrupted write. */
  temporaryMs: number;
  /** An unreferenced committed file must be at least this old before it may be removed. */
  orphanMs: number;
};

export const DEFAULT_STORAGE_AGE_LIMITS: StorageAgeLimits = {
  temporaryMs: 60 * 60 * 1000,
  orphanMs: 24 * 60 * 60 * 1000,
};

export type StorageLayout = {
  referenced: StorageEntry[];
  temporary: Array<{ entry: StorageEntry; ageMs: number; stale: boolean }>;
  orphans: Array<{ entry: StorageEntry; ageMs: number; removable: boolean }>;
  /** Names that documents refer to but that are not in the storage. */
  missing: string[];
};

/** Pure: the clock is a parameter, so tests decide what "now" is. */
export function classifyStorage(
  entries: readonly StorageEntry[],
  referencedNames: ReadonlySet<string>,
  nowMs: number,
  limits: StorageAgeLimits = DEFAULT_STORAGE_AGE_LIMITS,
): StorageLayout {
  const layout: StorageLayout = { referenced: [], temporary: [], orphans: [], missing: [] };
  const present = new Set<string>();

  for (const entry of entries) {
    const ageMs = Math.max(0, nowMs - entry.modifiedAtMs);

    if (entry.kind === "temporary") {
      layout.temporary.push({ entry, ageMs, stale: ageMs >= limits.temporaryMs });
      continue;
    }

    present.add(entry.name);
    if (referencedNames.has(entry.name)) {
      layout.referenced.push(entry);
    } else {
      layout.orphans.push({ entry, ageMs, removable: ageMs >= limits.orphanMs });
    }
  }

  layout.missing = [...referencedNames].filter((name) => !present.has(name)).sort();
  return layout;
}
