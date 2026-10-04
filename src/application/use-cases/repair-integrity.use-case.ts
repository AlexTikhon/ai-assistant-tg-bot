import { hashContent } from "../../core/content-hash.js";
import { logger } from "../../shared/logger.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { FileStorage } from "../ports/file-storage.js";
import type { IntegrityStore } from "../ports/integrity-store.js";
import type { InspectIntegrityUseCase, IntegrityReport } from "./inspect-integrity.use-case.js";

export type RepairAction =
  | { kind: "rebuilt-full-text-index" }
  | { kind: "backfilled-content-hash"; documentId: string; fileName: string }
  | { kind: "removed-temporary-file"; file: string }
  | { kind: "removed-orphan-file"; file: string }
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
  /** Epoch milliseconds (kept so a repair and its inspection can share one fake clock in tests). */
  now: () => number;
};

const log = logger.child({ operation: "repairIntegrity" });

/**
 * The explicit repair mode of `npm run integrity -- --repair`. Only deterministic repairs that cannot lose
 * user data and cannot cost money:
 *
 * - rebuild the full-text index (derived entirely from the chunk text),
 * - record the missing content hash of a document whose original file is present,
 * - delete temporary leftovers of interrupted writes that are old enough not to belong to a running one,
 * - with `removeOrphans`: delete old unreferenced stored files.
 *
 * It never deletes documents or chunks, never regenerates embeddings, never replaces files and never
 * guesses ownership: this class has no embeddings provider, and no way to write anything but the above.
 * A step that fails is reported and the others still run.
 */
export class RepairIntegrityUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(options: RepairOptions): Promise<RepairResult> {
    const { inspect, store, documents, files } = this.deps;
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

    if (before.issues.some((issue) => issue.code === "fts-mismatch")) {
      await attempt("rebuild full-text index", { kind: "rebuilt-full-text-index" }, () => store.rebuildFullText());
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
      if (options.removeOrphans && issue.code === "orphan-file" && issue.removable && issue.file) {
        const file = issue.file;
        await attempt(`remove orphan file ${file}`, { kind: "removed-orphan-file", file }, () => files.delete(file));
      }
    }

    return { actions, after: await inspect.execute() };
  }
}
