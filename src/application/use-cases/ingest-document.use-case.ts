import { randomUUID } from "node:crypto";
import { hashContent } from "../../core/content-hash.js";
import { isSupportedFileName } from "../../core/document.js";
import { normalizeDisplayFileName } from "../../core/file-validation.js";
import type { DocumentRecord } from "../../core/document.js";
import type { IndexHealth } from "../../core/index-health.js";
import { ValidationError } from "../../shared/errors.js";
import { KeyedMutex } from "../../shared/keyed-mutex.js";
import { logger } from "../../shared/logger.js";
import { describeDocumentIndex } from "../describe-document-index.js";
import { findDocumentByContent } from "../find-document-by-content.js";
import { restoreMissingOriginal } from "../restore-original.js";
import { prepareIndex, toChunkRecords } from "../prepare-index.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { FileStorage } from "../ports/file-storage.js";
import type { DocumentTextExtractor } from "../ports/text-extractor.js";
import { throwIfCancelled } from "../../shared/operation.js";

export type IngestDocumentInput = {
  userId: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
};

/**
 * What an upload led to. Every variant names the document the user ends up with; how to present it is up to
 * the caller. No hash, row or storage detail is exposed.
 */
export type IngestDocumentResult =
  | {
      kind: "created";
      documentId: string;
      fileName: string;
      chunksCount: number;
      textLength: number;
    }
  | {
      /**
       * The same user already has a document with exactly these bytes. Nothing was extracted, embedded or stored.
       * `fileName` is the existing document's name (it may differ from the uploaded one). `health` tells whether
       * that document is searchable as configured, so the caller can say more than "already there".
       */
      kind: "already-exists";
      documentId: string;
      fileName: string;
      chunksCount: number;
      textLength: number;
      health: IndexHealth;
      /** True when the document's original file was missing from storage and this upload restored it (nothing else changed). */
      restoredOriginal?: boolean;
    };

type Dependencies = {
  documents: DocumentRepository;
  files: FileStorage;
  extractor: DocumentTextExtractor;
  embeddings: EmbeddingsProvider;
  /** Document id source. Random by default; evaluation injects a sequence so that tie-breaking in ranking is reproducible. */
  newId?: () => string;
  /** Per-user serialization shared with the other use cases that change a user's documents. A private one by default. */
  locks?: KeyedMutex;
  options: {
    maxUploadBytes: number;
    chunkSize: number;
    chunkOverlap: number;
    maxDocumentsPerUser: number;
    maxStorageBytesPerUser: number;
    maxChunksPerDocument: number;
    maxChunksPerUser?: number;
  };
};

const log = logger.child({ operation: "ingestDocument" });

/**
 * Turns an uploaded file into a searchable document - once.
 *
 * Identity is the SHA-256 of the file's bytes, scoped to the uploading user: the same bytes again are answered
 * with `already-exists` before anything is extracted, embedded, stored or counted against a quota, and the
 * same name with other bytes is simply another document. (Another user's documents are never consulted.)
 *
 * All fallible work that has no side effects (validation, extraction, splitting, embedding - see prepareIndex)
 * happens first. Only then is the file written, and the metadata + chunks are saved in one transaction. If
 * that fails the file is removed again (compensation), so a failed ingestion leaves nothing behind; a crash
 * between the two steps can only leave an unreferenced file, which `npm run integrity` reports.
 *
 * Per-user limits (documents, stored bytes, chunks per document) are checked before any paid work.
 * Ingestions of the same user run one at a time, otherwise two simultaneous uploads could both pass the
 * duplicate and quota checks; different users never wait for each other.
 */
export class IngestDocumentUseCase {
  private readonly userLocks: KeyedMutex;

  constructor(private readonly deps: Dependencies) {
    this.userLocks = deps.locks ?? new KeyedMutex();
  }

  execute(input: IngestDocumentInput): Promise<IngestDocumentResult> {
    return this.userLocks.run(input.userId, () => this.ingest(input));
  }

  private async ingest(input: IngestDocumentInput): Promise<IngestDocumentResult> {
    throwIfCancelled();
    const startedAt = Date.now();
    const { documents, files, extractor, embeddings, options } = this.deps;
    // The name is metadata: cleaned of control and direction characters and bounded, never used as a path (the stored file gets a generated name).
    const fileName = normalizeDisplayFileName(input.fileName);

    if (!isSupportedFileName(fileName)) {
      throw new ValidationError("Unsupported file type. Send PDF, MD, or TXT.");
    }
    if (input.data.byteLength === 0) {
      throw new ValidationError("The uploaded file is empty.");
    }
    if (input.data.byteLength > options.maxUploadBytes) {
      throw new ValidationError(`The file is too large. The limit is ${formatMegabytes(options.maxUploadBytes)}.`);
    }

    const contentHash = hashContent(input.data);
    const existing = await findDocumentByContent({ documents, files }, input.userId, contentHash, input.data.byteLength);
    if (existing) {
      const { chunksCount, health } = await describeDocumentIndex(
        documents,
        { embeddingModel: embeddings.model, chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap },
        existing,
      );
      log.info(
        { userId: input.userId, documentId: existing.id, indexState: health.state, durationMs: Date.now() - startedAt },
        "Duplicate upload: the document already exists",
      );
      const restoredOriginal = await restoreMissingOriginal({ documents, files }, existing, input.data);
      return {
        kind: "already-exists",
        documentId: existing.id,
        fileName: existing.fileName,
        chunksCount,
        textLength: existing.textLength,
        health,
        ...(restoredOriginal ? { restoredOriginal } : {}),
      };
    }

    await this.assertWithinQuota(input.userId, input.data.byteLength);

    const maxChunksPerUser = options.maxChunksPerUser ?? 10_000;
    const prepared = await prepareIndex({ extractor, embeddings }, { ...input, fileName }, {
      ...options, maxChunksPerUser, remainingChunks: maxChunksPerUser - await documents.countChunksForUser(input.userId),
    });

    const documentId = (this.deps.newId ?? randomUUID)();
    const createdAt = new Date().toISOString();
    throwIfCancelled();
    const storedName = await files.save(fileName, input.data);

    const document: DocumentRecord = {
      id: documentId,
      userId: input.userId,
      fileName,
      storedName,
      mimeType: input.mimeType,
      fileSize: input.data.byteLength,
      textLength: prepared.textLength,
      summary: null,
      createdAt,
      indexProfile: prepared.profile,
      contentHash,
      documentVersion: 1,
    };
    const chunks = toChunkRecords(prepared, { documentId, userId: input.userId, createdAt });

    try {
      throwIfCancelled();
      await documents.saveWithChunks(document, chunks, maxChunksPerUser);
    } catch (error) {
      await files
        .delete(storedName)
        .catch((err) => log.warn({ err, documentId, storedName }, "Failed to remove file after failed ingestion"));
      throw error;
    }

    log.info(
      {
        userId: input.userId,
        documentId,
        chunks: chunks.length,
        embeddingRequests: prepared.embeddingRequests,
        textLength: prepared.textLength,
        durationMs: Date.now() - startedAt,
      },
      "Document ingested",
    );

    return { kind: "created", documentId, fileName, chunksCount: chunks.length, textLength: prepared.textLength };
  }

  private async assertWithinQuota(userId: string, incomingBytes: number) {
    const { documents, options } = this.deps;
    const usage = await documents.getUsage(userId);

    if (usage.documentCount >= options.maxDocumentsPerUser) {
      throw new ValidationError(
        `You can store at most ${options.maxDocumentsPerUser} documents. Delete one with /delete <documentId> first.`,
      );
    }
    if (usage.totalBytes + incomingBytes > options.maxStorageBytesPerUser) {
      throw new ValidationError(
        `This file would exceed your storage limit of ${formatMegabytes(options.maxStorageBytesPerUser)}. ` +
          "Delete a document with /delete <documentId> to free space.",
      );
    }
  }
}

function formatMegabytes(bytes: number) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
