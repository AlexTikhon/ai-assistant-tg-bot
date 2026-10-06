import { hashContent } from "../../core/content-hash.js";
import { logger } from "../../shared/logger.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { FileStorage } from "../ports/file-storage.js";
import type { IntegrityStore } from "../ports/integrity-store.js";
import type { RestoreArtifacts } from "../ports/restore-artifacts.js";
import type { InspectIntegrityUseCase, IntegrityReport } from "./inspect-integrity.use-case.js";

export type RepairAction =
  /** Only reported when the rebuilt index was verified: every chunk indexed, the text matches, a sample of searches works. */
  | { kind: "rebuilt-full-text-index"; verified: { chunks: number; searchesChecked: number; contentCheck: "compared" | "skipped" } }
  | { kind: "backfilled-content-hash"; documentId: string; fileName: string }
  | { kind: "removed-temporary-file"; file: string }
  | { kind: "removed-orphan-file"; file: string }
  | { kind: "removed-restore-staging"; name: string }
  | { kind: "failed"; step: string; reason: string };

export type RepairOptions = {
  /** Also delete unreferenced stored files that are old enough. A separate, explicit decision: not part of a plain repair. */
  removeOrphans?: boolean;
};

export type RepairResult = {
  /** Exactly what was changed (and what failed). Empty when there was nothing safe to do. */
  actions: RepairAction[];
  /** A fresh check after the repair, so the operator sees what remains. */
  after: IntegrityReport;
};

type Dependencies = {
  inspect: InspectIntegrityUseCase;
  store: IntegrityStore;
  documents: DocumentRepository;
  files: FileStorage;
  /** The data directory's restore leftovers; absent where there is none. */
  restoreArtifacts?: RestoreArtifacts;
  /** Epoch milliseconds (kept so a repair and its inspection can share one fake clock in tests). */
  now: () => number;
};

const log = logger.child({ operation: "repairIntegrity" });

const FULL_TEXT_CODES: ReadonlySet<string> = new Set(["fts-mismatch", "fts-content-mismatch", "fts-search-broken"]);

/**
 * The explicit repair mode of `npm run integrity -- --repair`. Only deterministic repairs that cannot lose
 * user data and cannot cost money:
 *
 * - rebuild the full-text index (derived entirely from the chunk text) - and then verify it: that SQL ran is not evidence that
 *   the index is right, so a rebuild whose result fails the coverage, content or search check is reported as failed,
 * - record the missing content hash of a document whose original file is present,
 * - delete temporary leftovers of interrupted writes that are old enough not to belong to a running one,
 * - delete the staging directory of a restore that was interrupted long ago (never the kept previous installation),
 * - with `removeOrphans`: delete old unreferenced stored files.
 *
 * It never deletes documents or chunks, never regenerates embeddings, never replaces files and never
 * guesses ownership: this class has no embeddings provider, and no way to write anything but the above.
 * A step that fails is reported and the others still run.
 */
export class RepairIntegrityUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(options: RepairOptions): Promise<RepairResult> {
    const { inspect, documents, files } = this.deps;
    const before = await inspect.execute();
    const actions: RepairAction[] = [];

    const attempt = async (step: string, action: RepairAction, task: () => Promise<void>) => {
      try {
        await task();
        actions.push(action);
      } catch (err) {
        log.warn({ err, step }, "Integrity repair step failed");
        actions.push({ kind: "failed", step, reason: err instanceof Error ? err.message : String(err) });
      }
    };

    if (before.issues.some((issue) => FULL_TEXT_CODES.has(issue.code))) {
      await this.rebuildFullText(actions);
    }

    for (const issue of before.issues) {
      if (issue.code === "unknown-content-hash" && issue.repairable && issue.documentId && issue.userId) {
        const { userId, documentId } = issue;
        const stored = await documents.findById(userId, documentId);
        if (!stored) continue;
        await attempt(
          `backfill content hash of ${documentId}`,
          { kind: "backfilled-content-hash", documentId, fileName: issue.fileName ?? stored.fileName },
          async () => {
            await documents.setContentHash(userId, documentId, hashContent(await files.read(stored.storedName)));
          },
        );
      }
      if (issue.code === "temporary-file" && issue.repairable && issue.file) {
        const file = issue.file;
        await attempt(`remove temporary file ${file}`, { kind: "removed-temporary-file", file }, () => files.deleteTemporary(file));
      }
      if (issue.code === "interrupted-restore" && issue.repairable && issue.file && this.deps.restoreArtifacts) {
        const { restoreArtifacts } = this.deps;
        const name = issue.file;
        await attempt(`remove interrupted restore directory ${name}`, { kind: "removed-restore-staging", name }, () => restoreArtifacts.remove(name));
      }
      if (options.removeOrphans && issue.code === "orphan-file" && issue.removable && issue.file) {
        const file = issue.file;
        await attempt(`remove orphan file ${file}`, { kind: "removed-orphan-file", file }, () => files.delete(file));
      }
    }

    return { actions, after: await inspect.execute() };
  }

  private async rebuildFullText(actions: RepairAction[]) {
    const { store } = this.deps;
    const step = "rebuild full-text index";

    try {
      await store.rebuildFullText();
    } catch (err) {
      log.warn({ err, step }, "Integrity repair step failed");
      actions.push({ kind: "failed", step, reason: err instanceof Error ? err.message : String(err) });
      return;
    }

    // Verify what the rebuild produced, independently of the statement that produced it.
    const problems: string[] = [];
    let verifiedChunks = 0;
    let searches = 0;
    let contentCheck: "compared" | "skipped" = "compared";
    try {
      const coverage = await store.checkFullText();
      verifiedChunks = coverage.chunkRows;
      if (coverage.missing > 0 || coverage.extra > 0) {
        problems.push(`${coverage.missing} chunks are still not indexed and ${coverage.extra} index entries have no chunk`);
      }
      const content = await store.checkFullTextContent();
      searches = content.probe.checked;
      contentCheck = content.index.status === "skipped" ? "skipped" : "compared";
      if (content.index.status === "mismatch") problems.push(`the index still does not match the chunk text (${content.index.detail ?? "checksum mismatch"})`);
      if (content.probe.missing > 0) problems.push(`${content.probe.missing} of ${content.probe.checked} sampled chunks cannot be found by keyword search`);
      if (content.probe.leaked > 0) problems.push(`${content.probe.leaked} of ${content.probe.checked} sampled chunks are found for another user`);
    } catch (err) {
      problems.push(`the rebuilt index could not be verified: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (problems.length > 0) {
      const reason = `the index was rebuilt but failed verification: ${problems.join("; ")}`;
      log.warn({ step, problems }, "Integrity repair: the rebuilt full-text index failed verification");
      actions.push({ kind: "failed", step, reason });
      return;
    }
    actions.push({ kind: "rebuilt-full-text-index", verified: { chunks: verifiedChunks, searchesChecked: searches, contentCheck } });
  }
}
