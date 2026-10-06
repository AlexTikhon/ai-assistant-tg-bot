import { hashContent } from "../../core/content-hash.js";
import { isSupportedFileName } from "../../core/document.js";
import { normalizeDisplayFileName } from "../../core/file-validation.js";
import { fileTooLargeError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { KeyedMutex } from "../../shared/keyed-mutex.js";
import { logger } from "../../shared/logger.js";
import { describeDocumentIndex } from "../describe-document-index.js";
import { findDocumentByContent } from "../find-document-by-content.js";
import { prepareIndex, toChunkRecords } from "../prepare-index.js";
import { restoreMissingOriginal } from "../restore-original.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { FileStorage } from "../ports/file-storage.js";
import type { DocumentTextExtractor } from "../ports/text-extractor.js";
import type { IngestDocumentResult } from "./ingest-document.use-case.js";
import { throwIfCancelled } from "../../shared/operation.js";

export type ReplaceDocumentInput = {
  userId: string;
  /** The document to replace. It must belong to `userId`. */
  documentId: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
};

export type ReplaceDocumentResult =
  | {
      kind: "replaced";
      documentId: string;
      fileName: string;
      chunksCount: number;
      textLength: number;
      /** 2 after the first replacement. */
      documentVersion: number;
    }
  /** The document already has exactly these bytes and a usable current index: nothing was done. */
  | Extract<IngestDocumentResult, { kind: "already-exists" }>;

type Dependencies = {
  documents: DocumentRepository;
  files: FileStorage;
  extractor: DocumentTextExtractor;
  embeddings: EmbeddingsProvider;
  /** Per-user serialization shared with ingestion. A private one by default. */
  locks?: KeyedMutex;
  options: {
    maxUploadBytes: number;
    chunkSize: number;
    chunkOverlap: number;
    maxStorageBytesPerUser: number;
    maxChunksPerDocument: number;
    maxChunksPerUser?: number;
  };
};

const log = logger.child({ operation: "replaceDocument" });

/**
 * Replaces the content of a document the user owns - deliberately, by id; a file name is never enough to
 * replace anything (see IngestDocumentUseCase: the same name with other bytes is a new document).
 *
 * Prepare, then swap. Everything that can fail or costs money (ownership, validation, extraction, splitting,
 * embedding, validating the vectors) happens first and only reads. Then the new file is written, the
 * database swaps document row and *all* chunks in one transaction (the full-text index follows through its
 * triggers), and only after that commit is the previous file deleted:
 *
 *   prepare index  ->  write new file  ->  swap in the database  ->  delete old file
 *   (fails: nothing)   (fails: nothing)    (fails: delete new file)  (fails: log; leftover = orphan)
 *
 * So the previous document and index stay usable until the new ones fully exist, and a failure at any stage
 * leaves the old state. The id, owner, creation time and every citation that refers to the id survive;
 * the cached summary does not (it described the old content). The file name becomes the new upload's name.
 */
export class ReplaceDocumentUseCase {
  private readonly userLocks: KeyedMutex;

  constructor(private readonly deps: Dependencies) {
    this.userLocks = deps.locks ?? new KeyedMutex();
  }

  execute(input: ReplaceDocumentInput): Promise<ReplaceDocumentResult> {
    return this.userLocks.run(input.userId, () => this.replace(input));
  }

  private async replace(input: ReplaceDocumentInput): Promise<ReplaceDocumentResult> {
    throwIfCancelled();
    const startedAt = Date.now();
    const { documents, files, extractor, embeddings, options } = this.deps;
    const fileName = normalizeDisplayFileName(input.fileName); // metadata only; see IngestDocumentUseCase

    if (!isSupportedFileName(fileName)) {
      throw new ValidationError("Unsupported file type. Send PDF, MD, or TXT.");
    }
    if (input.data.byteLength === 0) {
      throw new ValidationError("The uploaded file is empty.");
    }
    if (input.data.byteLength > options.maxUploadBytes) {
      throw fileTooLargeError(options.maxUploadBytes);
    }

    // Ownership first: nothing below runs for a document that is not the user's (or does not exist).
    const current = await documents.findById(input.userId, input.documentId);
    if (!current) {
      throw new NotFoundError();
    }

    const contentHash = hashContent(input.data);
    const activeRecipe = { embeddingModel: embeddings.model, chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap };

    const sameContent = await findDocumentByContent({ documents, files }, input.userId, contentHash, input.data.byteLength);
    if (sameContent && sameContent.id !== current.id) {
      throw new ValidationError(`You already have this file as document ${sameContent.id}.`);
    }
    if (sameContent) {
      const { chunksCount, health } = await describeDocumentIndex(documents, activeRecipe, current);
      // Identical bytes and a usable current index: nothing to replace. Otherwise the user is asking for a rebuild.
      if (health.state === "current") {
        // The same bytes also bring back a lost original, which needs no re-indexing.
        const restoredOriginal = await restoreMissingOriginal({ documents, files }, current, input.data);
        return {
          kind: "already-exists",
          documentId: current.id,
          fileName: current.fileName,
          chunksCount,
          textLength: current.textLength,
          health,
          ...(restoredOriginal ? { restoredOriginal } : {}),
        };
      }
    }

    const usage = await documents.getUsage(input.userId);
    if (usage.totalBytes - current.fileSize + input.data.byteLength > options.maxStorageBytesPerUser) {
      throw new ValidationError(
        "The new file would exceed your storage limit. Delete a document with /delete <documentId> to free space.",
      );
    }

    // Prepare: the only paid and failure-prone steps. Nothing has been changed yet.
    const maxChunksPerUser = options.maxChunksPerUser ?? 10_000;
    const remainingChunks = maxChunksPerUser - await documents.countChunksForUser(input.userId) + await documents.countChunks(input.userId, input.documentId);
    const prepared = await prepareIndex({ extractor, embeddings }, { ...input, fileName }, { ...options, maxChunksPerUser, remainingChunks });

    const updatedAt = new Date().toISOString();
    throwIfCancelled();
    const storedName = await files.save(fileName, input.data);

    let swap;
    try {
      throwIfCancelled();
      swap = await documents.replaceDocument(input.userId, input.documentId, {
        maxChunksPerUser,
        fileName,
        storedName,
        mimeType: input.mimeType,
        fileSize: input.data.byteLength,
        textLength: prepared.textLength,
        contentHash,
        indexProfile: prepared.profile,
        chunks: toChunkRecords(prepared, { documentId: input.documentId, userId: input.userId, createdAt: updatedAt }),
        updatedAt,
      });
    } catch (error) {
      // Compensation: the swap did not happen, so the new file is garbage. The previous document is untouched.
      await files
        .delete(storedName)
        .catch((err) => log.warn({ err, documentId: input.documentId, storedName }, "Failed to remove the new file after a failed replacement"));
      throw error;
    }

    // Finalize: the old file is only garbage now that the database no longer refers to it. A failure here
    // leaves an unreferenced file (reported by `npm run integrity`), never an inconsistent document.
    await files
      .delete(swap.previousStoredName)
      .catch((err) =>
        log.warn({ err, documentId: input.documentId, storedName: swap.previousStoredName }, "Failed to remove the replaced file"),
      );

    log.info(
      {
        userId: input.userId,
        documentId: input.documentId,
        documentVersion: swap.documentVersion,
        chunks: prepared.chunks.length,
        embeddingRequests: prepared.embeddingRequests,
        durationMs: Date.now() - startedAt,
      },
      "Document replaced",
    );

    return {
      kind: "replaced",
      documentId: input.documentId,
      fileName,
      chunksCount: prepared.chunks.length,
      textLength: prepared.textLength,
      documentVersion: swap.documentVersion,
    };
  }
}
