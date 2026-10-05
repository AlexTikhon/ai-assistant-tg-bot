import { hashContent } from "../../core/content-hash.js";
import { MARKDOWN_EXTRACTOR_VERSION } from "../../core/index-profile.js";
import type { StaleReason } from "../../core/index-profile.js";
import { classifyStorage, DEFAULT_STORAGE_AGE_LIMITS } from "../../core/storage-layout.js";
import type { StorageAgeLimits } from "../../core/storage-layout.js";
import { getFileExtension } from "../../shared/utils/path.js";
import { assessDocument } from "../assess-index.js";
import type { ActiveRecipe, DocumentAssessment } from "../assess-index.js";
import type { FileStorage } from "../ports/file-storage.js";
import type { IndexMaintenance } from "../ports/index-maintenance.js";
import type { RestoreArtifacts } from "../ports/restore-artifacts.js";
import type { DocumentFacts, IntegrityStore } from "../ports/integrity-store.js";

export type IntegrityCode =
  | "database-corrupt"
  | "missing-file"
  | "unreadable-file"
  | "file-size-mismatch"
  | "content-hash-mismatch"
  | "unknown-content-hash"
  | "duplicate-content"
  | "orphan-file"
  | "temporary-file"
  | "interrupted-restore"
  | "previous-installation"
  | "no-chunks"
  | "unreadable-embedding"
  | "mixed-dimensions"
  | "chunk-index-gap"
  | "foreign-chunk"
  | "orphan-chunks"
  | "fts-mismatch"
  | "fts-content-mismatch"
  | "fts-search-broken"
  | "fts-check-skipped"
  | "stale-index";

export type IntegrityIssue = {
  code: IntegrityCode;
  /** error: data is wrong or lost; warning: works, but needs attention. */
  severity: "error" | "warning";
  message: string;
  userId?: string;
  documentId?: string;
  fileName?: string;
  /** The storage name, for issues about a file that no document refers to. */
  file?: string;
  /** For orphan and temporary files: old enough that removing it cannot hit a write in progress. */
  removable?: boolean;
  /** For stale-index: which workflow brings the document up to date. */
  needs?: "reembed" | "rechunk";
  /** What the operator can do about it; absent when nothing automatic exists. */
  remedy?: string;
  /** A plain `--repair` fixes this (deterministic, free, loses nothing). */
  repairable?: boolean;
};

export type IntegritySummary = {
  documents: number;
  chunks: number;
  errors: number;
  warnings: number;
  /** Documents (and their chunks) that `npm run reindex` / `npm run reindex -- --rechunk` would process. */
  needsReembed: number;
  needsRechunk: number;
  chunksToEmbed: number;
};

export type IntegrityReport = { issues: IntegrityIssue[]; summary: IntegritySummary };

type Dependencies = {
  store: IntegrityStore;
  maintenance: IndexMaintenance;
  files: FileStorage;
  /** What a current index means: the configured embedding model and chunking. */
  recipe: Omit<ActiveRecipe, "embeddingDimension">;
  /** Epoch milliseconds; injectable so ages are testable. */
  now: () => number;
  /** Read every stored file to verify its content hash (slow for large collections). */
  verifyHashes: boolean;
  /**
   * Also compare the full-text index with the chunk text and search for a sample of chunks. Reads the whole database once,
   * so only the explicit commands enable it (`npm run integrity`, backup verification, restore) - never the startup check.
   */
  deepFullText?: boolean;
  /** The working directories `npm run restore` leaves in the data directory; absent where there is no data directory to look in. */
  restoreArtifacts?: RestoreArtifacts;
  limits?: StorageAgeLimits;
};

const REPAIR = "npm run integrity -- --repair";
const REINDEX = "npm run reindex";
const RECHUNK = "npm run reindex -- --rechunk";

/**
 * The offline integrity check behind `npm run integrity`. It compares what the database says with what the
 * file system and the index really contain, and reports every difference. It only reads: the store's single
 * write method and the file storage's write methods are never called here (a test guards that), and it never
 * calls an embeddings provider - it has none.
 */
export class InspectIntegrityUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(): Promise<IntegrityReport> {
    const { store, maintenance, files, recipe, now } = this.deps;
    const issues: IntegrityIssue[] = [];

    for (const problem of await store.checkDatabase()) {
      issues.push({ code: "database-corrupt", severity: "error", message: `The database reports a problem: ${problem}` });
    }

    const documents = await store.listDocuments();
    const entries = await files.list();
    const layout = classifyStorage(entries, new Set(documents.map((document) => document.storedName)), now(), this.deps.limits ?? DEFAULT_STORAGE_AGE_LIMITS);
    const missing = new Set(layout.missing);
    const sizes = new Map(entries.filter((entry) => entry.kind === "stored").map((entry) => [entry.name, entry.size]));

    const assessments = new Map<string, DocumentAssessment>(
      (await maintenance.listIndexedDocuments({ model: recipe.embeddingModel })).map((indexed) => [indexed.documentId, assessDocument(indexed, recipe)]),
    );

    for (const document of documents) {
      issues.push(...(await this.inspectFile(document, missing, sizes.get(document.storedName))));
      issues.push(...inspectChunks(document));
      const assessment = assessments.get(document.documentId);
      if (assessment && document.chunkCount > 0) {
        issues.push(...inspectStaleness(document, assessment));
      }
    }

    issues.push(...findDuplicateContent(documents));

    const orphanChunks = await store.countOrphanChunks();
    if (orphanChunks > 0) {
      issues.push({
        code: "orphan-chunks",
        severity: "error",
        message: `${orphanChunks} chunks belong to a document that no longer exists.`,
        remedy: "Inspect the database; deleting chunks of unknown documents is not done automatically.",
      });
    }

    const fullText = await store.checkFullText();
    if (fullText.missing > 0 || fullText.extra > 0) {
      issues.push({
        code: "fts-mismatch",
        severity: "error",
        message: `The full-text index is out of step with the chunks: ${fullText.missing} chunks are not indexed, ${fullText.extra} index entries have no chunk (${fullText.chunkRows} chunks, ${fullText.indexedRows} entries). Keyword search misses or invents results until it is rebuilt.`,
        remedy: REPAIR,
        repairable: true,
      });
    }

    if (this.deps.deepFullText) {
      issues.push(...(await this.inspectFullTextContent(fullText.missing + fullText.extra > 0)));
    }

    for (const { entry, removable } of layout.orphans) {
      issues.push({
        code: "orphan-file",
        severity: "warning",
        file: entry.name,
        removable,
        message: `Stored file ${entry.name} (${entry.size} bytes) is not referenced by any document${removable ? "" : " (too recent to remove: it may belong to an upload in progress)"}.`,
        remedy: removable ? `${REPAIR} --remove-orphans` : undefined,
      });
    }
    for (const { entry, stale } of layout.temporary) {
      issues.push({
        code: "temporary-file",
        severity: "warning",
        file: entry.name,
        removable: stale,
        message: `Temporary file ${entry.name} is the leftover of an interrupted write${stale ? "" : " (recent: a write may still be running)"}.`,
        remedy: stale ? REPAIR : undefined,
        repairable: stale,
      });
    }

    issues.push(...(await this.inspectRestoreArtifacts()));

    return { issues, summary: summarize(documents, assessments, issues) };
  }

  /** What a restore left behind: the staging area of an interrupted one, and the installation a finished one replaced. */
  private async inspectRestoreArtifacts(): Promise<IntegrityIssue[]> {
    if (!this.deps.restoreArtifacts) return [];
    const limits = this.deps.limits ?? DEFAULT_STORAGE_AGE_LIMITS;
    const issues: IntegrityIssue[] = [];

    for (const artifact of await this.deps.restoreArtifacts.list()) {
      const ageMs = Math.max(0, this.deps.now() - artifact.modifiedAtMs);
      if (artifact.kind === "staging") {
        const stale = ageMs >= limits.temporaryMs;
        issues.push({
          code: "interrupted-restore",
          severity: "warning",
          file: artifact.name,
          removable: stale,
          repairable: stale,
          message: `${artifact.name} is the working directory of a restore${stale ? " that was interrupted" : " (recent: a restore may still be running)"}. The live installation was not changed by it.`,
          remedy: stale ? REPAIR : undefined,
        });
      } else {
        issues.push({
          code: "previous-installation",
          severity: "warning",
          file: artifact.name,
          message: `${artifact.name} is the installation a restore replaced (its database and files), kept so that the restore can be undone. It holds user documents.`,
          remedy: "Delete the directory yourself once the restored data has been checked; this is never done automatically.",
        });
      }
    }
    return issues;
  }

  /**
   * The content-level full-text check. When the cheap row-count check already reported a mismatch, the content comparison would
   * only repeat it in a noisier form, so it is not reported twice.
   */
  private async inspectFullTextContent(alreadyReported: boolean): Promise<IntegrityIssue[]> {
    const check = await this.deps.store.checkFullTextContent();
    const issues: IntegrityIssue[] = [];

    if (check.index.status === "mismatch" && !alreadyReported) {
      issues.push({
        code: "fts-content-mismatch",
        severity: "error",
        message: `The full-text index does not describe the stored chunk text (${check.index.detail ?? "checksum mismatch"}). Keyword search can miss chunks or return stale ones until it is rebuilt.`,
        remedy: REPAIR,
        repairable: true,
      });
    }
    if (check.index.status === "skipped") {
      issues.push({ code: "fts-check-skipped", severity: "warning", message: `The content-level full-text check was skipped: ${check.index.detail ?? "not possible"}.` });
    }
    if (check.probe.missing > 0 || check.probe.leaked > 0) {
      issues.push({
        code: "fts-search-broken",
        severity: "error",
        message: `Keyword search returned wrong results for a sample of ${check.probe.checked} chunks: ${check.probe.missing} were not found by their owner, ${check.probe.leaked} were found for another user.`,
        remedy: check.probe.leaked > 0 ? "Not repaired automatically: a search that crosses users is a defect, not stale data." : REPAIR,
        repairable: check.probe.leaked === 0,
      });
    }
    return issues;
  }

  /** File presence, size and (optionally) the bytes of one document's original. */
  private async inspectFile(document: DocumentFacts, missing: Set<string>, size: number | undefined): Promise<IntegrityIssue[]> {
    const base = { userId: document.userId, documentId: document.documentId, fileName: document.fileName };
    const issues: IntegrityIssue[] = [];

    if (missing.has(document.storedName)) {
      issues.push({
        ...base,
        code: "missing-file",
        severity: "error",
        message: `The original file of ${document.fileName} is missing from storage. Its index still answers questions, but it cannot be re-chunked or re-extracted until the file is restored.`,
        remedy: "Restore the file from a backup, or have the owner send the same file again: it is restored without re-indexing.",
      });
    } else if (size !== undefined && size !== document.fileSize) {
      issues.push({
        ...base,
        code: "file-size-mismatch",
        severity: "warning",
        message: `The stored file of ${document.fileName} has ${size} bytes, the record says ${document.fileSize}.`,
      });
    }

    if (document.contentHash === null) {
      const canFix = !missing.has(document.storedName);
      issues.push({
        ...base,
        code: "unknown-content-hash",
        severity: "warning",
        message: `${document.fileName} has no recorded content hash (stored before hashes existed), so duplicate uploads of it are not recognised yet.`,
        remedy: canFix ? REPAIR : "Restore the original file first, then run the repair.",
        repairable: canFix,
      });
    } else if (this.deps.verifyHashes && !missing.has(document.storedName)) {
      try {
        const actual = hashContent(await this.deps.files.read(document.storedName));
        if (actual !== document.contentHash) {
          issues.push({
            ...base,
            code: "content-hash-mismatch",
            severity: "error",
            message: `The stored file of ${document.fileName} does not match its recorded content hash: it was changed or damaged after upload.`,
            remedy: "Restore the file from a backup, or send the document again with /replace.",
          });
        }
      } catch (error) {
        issues.push({
          ...base,
          code: "unreadable-file",
          severity: "error",
          message: `The stored file of ${document.fileName} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    return issues;
  }
}

function inspectChunks(document: DocumentFacts): IntegrityIssue[] {
  const base = { userId: document.userId, documentId: document.documentId, fileName: document.fileName };
  const issues: IntegrityIssue[] = [];

  if (document.chunkCount === 0) {
    return [
      {
        ...base,
        code: "no-chunks",
        severity: "error",
        message: `${document.fileName} has no chunks: nothing can be found in it.`,
        remedy: "Re-chunk it from the original file: npm run reindex -- --rechunk --document " + document.documentId,
      },
    ];
  }

  if (document.unreadableChunks > 0) {
    issues.push({
      ...base,
      code: "unreadable-embedding",
      severity: "error",
      message: `${document.unreadableChunks} of ${document.chunkCount} chunks of ${document.fileName} have an unreadable vector (semantic search skips them; keyword search still finds their text).`,
      remedy: `${REINDEX} -- --document ${document.documentId}`,
    });
  }
  if (document.readableDimensions > 1) {
    issues.push({
      ...base,
      code: "mixed-dimensions",
      severity: "error",
      message: `The vectors of ${document.fileName} have ${document.readableDimensions} different dimensions.`,
      remedy: `${REINDEX} -- --document ${document.documentId}`,
    });
  }

  const contiguous =
    document.distinctChunkIndexes === document.chunkCount &&
    document.minChunkIndex === 0 &&
    document.maxChunkIndex === document.chunkCount - 1;
  if (!contiguous) {
    issues.push({
      ...base,
      code: "chunk-index-gap",
      severity: "error",
      message: `The chunks of ${document.fileName} are not numbered 0..${document.chunkCount - 1} without gaps or repeats (${document.distinctChunkIndexes} distinct positions for ${document.chunkCount} chunks).`,
      remedy: `${RECHUNK} --document ${document.documentId}`,
    });
  }
  if (document.foreignChunks > 0) {
    issues.push({
      ...base,
      code: "foreign-chunk",
      severity: "error",
      message: `${document.foreignChunks} chunks of ${document.fileName} are recorded for a different user than the document: ownership is inconsistent.`,
      remedy: "Not repaired automatically: ownership is never guessed.",
    });
  }

  return issues;
}

function describe(reason: StaleReason) {
  return `${reason.field}: ${reason.from ?? "unrecorded"} -> ${reason.to}`;
}

function inspectStaleness(document: DocumentFacts, assessment: DocumentAssessment): IntegrityIssue[] {
  // Unreadable vectors are reported as corruption above, not as a stale recipe.
  const reasons = assessment.reasons.filter((reason) => reason.field !== "vectors");
  if (reasons.length === 0) {
    return [];
  }

  const needs = assessment.stale.chunking || assessment.stale.extractor ? "rechunk" : "reembed";
  const predatesSections =
    getFileExtension(document.fileName) === ".md" &&
    reasons.some((reason) => reason.field === "extractorVersion" && reason.to === MARKDOWN_EXTRACTOR_VERSION);

  return [
    {
      userId: document.userId,
      documentId: document.documentId,
      fileName: document.fileName,
      code: "stale-index",
      severity: "warning",
      needs,
      message: predatesSections
        ? `${document.fileName} was indexed before Markdown section citations existed (${describe(reasons[0])}): it still answers questions but cites chunk numbers instead of sections. Re-chunking from the original file adds the sections.`
        : `${document.fileName} is indexed with another recipe than configured (${reasons.map(describe).join("; ")}).`,
      remedy: needs === "rechunk" ? RECHUNK : REINDEX,
    },
  ];
}

/** Several documents of one user with identical content. The oldest is the original; each later one is reported. */
function findDuplicateContent(documents: DocumentFacts[]): IntegrityIssue[] {
  const firstSeen = new Map<string, DocumentFacts>();
  const issues: IntegrityIssue[] = [];

  for (const document of documents) {
    if (document.contentHash === null) continue;
    const key = `${document.userId}:${document.contentHash}`;
    const original = firstSeen.get(key);
    if (!original) {
      firstSeen.set(key, document);
      continue;
    }
    issues.push({
      userId: document.userId,
      documentId: document.documentId,
      fileName: document.fileName,
      code: "duplicate-content",
      severity: "warning",
      message: `${document.fileName} has exactly the same content as the same user's document ${original.documentId} (${original.fileName}); new uploads of it are no longer duplicated.`,
      remedy: "The owner can delete one of them with /delete <documentId>; this is never done automatically.",
    });
  }

  return issues;
}

function summarize(documents: DocumentFacts[], assessments: Map<string, DocumentAssessment>, issues: IntegrityIssue[]): IntegritySummary {
  const stale = issues.filter((issue) => issue.code === "stale-index");
  const chunkCount = (documentId?: string) => (documentId === undefined ? 0 : (assessments.get(documentId)?.chunkCount ?? 0));

  return {
    documents: documents.length,
    chunks: documents.reduce((sum, document) => sum + document.chunkCount, 0),
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    needsReembed: stale.filter((issue) => issue.needs === "reembed").length,
    needsRechunk: stale.filter((issue) => issue.needs === "rechunk").length,
    chunksToEmbed: stale.reduce((sum, issue) => sum + chunkCount(issue.documentId), 0),
  };
}
