import { NotFoundError } from "../../shared/errors.js";
import { logger, scrubSecrets } from "../../shared/logger.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { EmbeddingTarget, IndexedDocument, IndexMaintenance } from "../ports/index-maintenance.js";
import { ensureQueryEmbedding } from "../validate-embeddings.js";
import type { ReindexDocumentUseCase } from "./reindex-document.use-case.js";

export type ReindexScope =
  /** Documents with chunks that do not match the configured model/dimension (the default). */
  | { kind: "stale" }
  /** Every document, e.g. after changing something the stale check cannot see. */
  | { kind: "all" }
  | { kind: "document"; documentId: string };

export type ReindexProgress = {
  /** 1-based position among the documents of this run. */
  position: number;
  total: number;
  documentId: string;
  fileName: string;
  outcome: "planned" | "reindexed" | "failed";
  chunks: number;
  reason?: string;
};

export type ReindexRequest = {
  scope: ReindexScope;
  /** Only list what would be re-indexed: no provider call, no change. */
  dryRun?: boolean;
  onProgress?: (progress: ReindexProgress) => void;
};

export type ReindexReport = {
  model: string;
  /** Dimension of the provider's vectors, when it was probed (stale scope, not a dry run). */
  dimension?: number;
  documents: number;
  chunks: number;
  succeeded: number;
  chunksReindexed: number;
  failed: Array<{ documentId: string; fileName: string; reason: string }>;
  dryRun: boolean;
};

type Dependencies = {
  maintenance: IndexMaintenance;
  reindexDocument: ReindexDocumentUseCase;
  embeddings: EmbeddingsProvider;
};

const log = logger.child({ operation: "reindex" });
const DIMENSION_PROBE_TEXT = "dimension probe";

/**
 * Operator workflow behind `npm run reindex`: finds the documents to refresh, re-indexes them one by
 * one and reports. Every document is independent - one failure is recorded and the run continues,
 * and a rerun naturally picks up whatever is still stale.
 */
export class RunReindexUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(request: ReindexRequest): Promise<ReindexReport> {
    const { embeddings } = this.deps;
    const dryRun = request.dryRun ?? false;

    const target: EmbeddingTarget = { model: embeddings.model };
    if (request.scope.kind === "stale" && !dryRun) {
      // The dimension a model produces is only known by asking it; one tiny request.
      const probe = await embeddings.embedQuery(DIMENSION_PROBE_TEXT);
      ensureQueryEmbedding(probe);
      target.dimension = probe.length;
    }

    const plan = await this.plan(request.scope, target);
    const report: ReindexReport = {
      model: target.model,
      dimension: target.dimension,
      documents: plan.length,
      chunks: plan.reduce((sum, document) => sum + document.chunkCount, 0),
      succeeded: 0,
      chunksReindexed: 0,
      failed: [],
      dryRun,
    };

    for (const [index, document] of plan.entries()) {
      const position = { position: index + 1, total: plan.length };
      const identity = { documentId: document.documentId, fileName: document.fileName };

      if (dryRun) {
        request.onProgress?.({ ...position, ...identity, outcome: "planned", chunks: document.chunkCount });
        continue;
      }

      try {
        const { chunksCount } = await this.deps.reindexDocument.execute(document.userId, document.documentId);
        report.succeeded += 1;
        report.chunksReindexed += chunksCount;
        request.onProgress?.({ ...position, ...identity, outcome: "reindexed", chunks: chunksCount });
      } catch (error) {
        const reason = scrubSecrets(error instanceof Error ? error.message : String(error));
        report.failed.push({ ...identity, reason });
        log.error({ err: error, documentId: document.documentId }, "Re-indexing a document failed");
        request.onProgress?.({ ...position, ...identity, outcome: "failed", chunks: 0, reason });
      }
    }

    return report;
  }

  private async plan(scope: ReindexScope, target: EmbeddingTarget): Promise<IndexedDocument[]> {
    const documents = await this.deps.maintenance.listIndexedDocuments(target);

    switch (scope.kind) {
      case "all":
        return documents;
      case "stale":
        return documents.filter((document) => document.staleChunkCount > 0);
      case "document": {
        const match = documents.filter((document) => document.documentId === scope.documentId);
        if (match.length === 0) {
          throw new NotFoundError(`Document ${scope.documentId} not found.`);
        }
        return match;
      }
    }
  }
}
