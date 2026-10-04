import type { StaleReason } from "../../core/index-profile.js";
import { NotFoundError } from "../../shared/errors.js";
import { logger, scrubSecrets } from "../../shared/logger.js";
import { assessDocument, summarizeAssessments } from "../assess-index.js";
import type { DocumentAssessment, IndexSummary } from "../assess-index.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { EmbeddingTarget, IndexMaintenance } from "../ports/index-maintenance.js";
import { ensureQueryEmbedding } from "../validate-embeddings.js";
import type { RechunkDocumentUseCase } from "./rechunk-document.use-case.js";
import type { ReindexDocumentUseCase } from "./reindex-document.use-case.js";

export type ReindexScope =
  /** Documents whose recorded index recipe is outdated (the default; which kinds depends on `rechunk`). */
  | { kind: "stale" }
  /** Every document, e.g. after changing something the stale check cannot see. */
  | { kind: "all" }
  | { kind: "document"; documentId: string };

/**
 * What is done to a document. "reembed" recomputes the vectors of the stored chunks (cheap: same text,
 * same chunk ids). "rechunk" re-reads the original file, extracts and splits it again and embeds the new
 * chunks (needed when chunk size/overlap/algorithm or the extraction changed).
 */
export type ReindexAction = "reembed" | "rechunk";

export type ReindexProgress = {
  /** 1-based position among the documents of this run. */
  position: number;
  total: number;
  documentId: string;
  fileName: string;
  outcome: "planned" | "reindexed" | "failed";
  action: ReindexAction;
  /** Why the document is being processed; empty for documents that are current but were asked for (--all). */
  reasons: StaleReason[];
  chunks: number;
  reason?: string;
};

export type ReindexRequest = {
  scope: ReindexScope;
  /**
   * Also apply chunk-layout and extraction changes by re-chunking from the original files. Without it only
   * outdated embeddings are refreshed (by re-embedding) and the other kinds are reported but left alone.
   */
  rechunk?: boolean;
  /** Only list what would be done and why: no provider call, no change. */
  dryRun?: boolean;
  onProgress?: (progress: ReindexProgress) => void;
};

/** A document that differs from the active recipe, and what this run does about it (null: nothing). */
export type StaleDocument = {
  documentId: string;
  fileName: string;
  reasons: StaleReason[];
  action: ReindexAction | null;
};

export type ReindexReport = {
  model: string;
  /** Dimension of the provider's vectors, when it was probed (stale scope, not a dry run). */
  dimension?: number;
  /** Documents this run processes (or would process). */
  documents: number;
  chunks: number;
  succeeded: number;
  chunksReindexed: number;
  reembedded: number;
  rechunked: number;
  failed: Array<{ documentId: string; fileName: string; reason: string }>;
  dryRun: boolean;
  /** How the whole index relates to the active recipe, independent of the scope. */
  summary: IndexSummary;
  /** Every stale document with the reasons, independent of the scope. */
  stale: StaleDocument[];
};

type Dependencies = {
  maintenance: IndexMaintenance;
  reindexDocument: ReindexDocumentUseCase;
  rechunkDocument: RechunkDocumentUseCase;
  embeddings: EmbeddingsProvider;
  /** The configured chunking: part of the recipe every document is compared with. */
  chunking: { chunkSize: number; chunkOverlap: number };
};

const log = logger.child({ operation: "reindex" });
const DIMENSION_PROBE_TEXT = "dimension probe";

/**
 * Operator workflow behind `npm run reindex`: compares every document's recorded recipe with the
 * configured one, processes the selected documents one by one and reports. Every document is
 * independent - one failure is recorded and the run continues - and a rerun naturally picks up
 * whatever is still stale.
 */
export class RunReindexUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(request: ReindexRequest): Promise<ReindexReport> {
    const { embeddings, chunking } = this.deps;
    const dryRun = request.dryRun ?? false;

    const target: EmbeddingTarget = { model: embeddings.model };
    if (request.scope.kind === "stale" && !dryRun) {
      // The dimension a model produces is only known by asking it; one tiny request.
      const probe = await embeddings.embedQuery(DIMENSION_PROBE_TEXT);
      ensureQueryEmbedding(probe);
      target.dimension = probe.length;
    }

    const documents = await this.deps.maintenance.listIndexedDocuments(target);
    const assessments = documents.map((document) =>
      assessDocument(document, {
        embeddingModel: target.model,
        embeddingDimension: target.dimension,
        ...chunking,
      }),
    );

    const selection = this.select(request, assessments);
    const plan = selection.filter((item) => item.action !== null);
    const report: ReindexReport = {
      model: target.model,
      dimension: target.dimension,
      documents: plan.length,
      chunks: plan.reduce((sum, item) => sum + item.assessment.chunkCount, 0),
      succeeded: 0,
      chunksReindexed: 0,
      reembedded: 0,
      rechunked: 0,
      failed: [],
      dryRun,
      summary: summarizeAssessments(assessments),
      stale: assessments
        .filter((assessment) => assessment.reasons.length > 0)
        .map((assessment) => ({
          documentId: assessment.documentId,
          fileName: assessment.fileName,
          reasons: assessment.reasons,
          action: selection.find((item) => item.assessment === assessment)?.action ?? null,
        })),
    };

    for (const [index, { assessment, action }] of plan.entries()) {
      const progress = {
        position: index + 1,
        total: plan.length,
        documentId: assessment.documentId,
        fileName: assessment.fileName,
        action: action!,
        reasons: assessment.reasons,
      };

      if (dryRun) {
        request.onProgress?.({ ...progress, outcome: "planned", chunks: assessment.chunkCount });
        continue;
      }

      try {
        const { chunksCount } =
          action === "rechunk"
            ? await this.deps.rechunkDocument.execute(assessment.userId, assessment.documentId)
            : await this.deps.reindexDocument.execute(assessment.userId, assessment.documentId);
        report.succeeded += 1;
        report.chunksReindexed += chunksCount;
        report[action === "rechunk" ? "rechunked" : "reembedded"] += 1;
        request.onProgress?.({ ...progress, outcome: "reindexed", chunks: chunksCount });
      } catch (error) {
        const reason = scrubSecrets(error instanceof Error ? error.message : String(error));
        report.failed.push({ documentId: assessment.documentId, fileName: assessment.fileName, reason });
        log.error({ err: error, documentId: assessment.documentId, action }, "Re-indexing a document failed");
        request.onProgress?.({ ...progress, outcome: "failed", chunks: 0, reason });
      }
    }

    return report;
  }

  /** The action for every assessed document in scope; null where this run leaves the document alone. */
  private select(request: ReindexRequest, assessments: DocumentAssessment[]) {
    const { scope } = request;
    const rechunk = request.rechunk ?? false;

    if (scope.kind === "document" && !assessments.some((assessment) => assessment.documentId === scope.documentId)) {
      throw new NotFoundError(`Document ${scope.documentId} not found.`);
    }

    return assessments.map((assessment): { assessment: DocumentAssessment; action: ReindexAction | null } => {
      const { stale } = assessment;
      switch (scope.kind) {
        case "all":
          return { assessment, action: rechunk ? "rechunk" : "reembed" };
        case "document":
          return {
            assessment,
            action: assessment.documentId !== scope.documentId ? null : rechunk ? "rechunk" : "reembed",
          };
        case "stale":
          if (rechunk && (stale.chunking || stale.extractor)) {
            return { assessment, action: "rechunk" };
          }
          return { assessment, action: stale.embedding ? "reembed" : null };
      }
    });
  }
}
