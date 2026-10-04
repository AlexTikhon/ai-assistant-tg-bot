import { randomUUID } from "node:crypto";
import { isSupportedFileName } from "../../core/document.js";
import type { ChunkRecord, DocumentRecord } from "../../core/document.js";
import { splitText } from "../../core/text-splitter.js";
import { ValidationError } from "../../shared/errors.js";
import { KeyedMutex } from "../../shared/keyed-mutex.js";
import { logger } from "../../shared/logger.js";
import { normalizeText } from "../../shared/utils/text.js";
import { ensureEmbeddingBatch } from "../validate-embeddings.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { FileStorage } from "../ports/file-storage.js";
import type { DocumentTextExtractor } from "../ports/text-extractor.js";

export type IngestDocumentInput = {
  userId: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
};

export type IngestDocumentResult = {
  documentId: string;
  fileName: string;
  chunksCount: number;
  textLength: number;
};

type Dependencies = {
  documents: DocumentRepository;
  files: FileStorage;
  extractor: DocumentTextExtractor;
  embeddings: EmbeddingsProvider;
  options: {
    maxUploadBytes: number;
    chunkSize: number;
    chunkOverlap: number;
    maxDocumentsPerUser: number;
    maxStorageBytesPerUser: number;
    maxChunksPerDocument: number;
  };
};

const log = logger.child({ operation: "ingestDocument" });

/**
 * Turns an uploaded file into a searchable document.
 *
 * All fallible work that has no side effects (validation, extraction, splitting, embedding) happens
 * first. Only then is the file written, and the metadata + chunks are saved in one transaction. If
 * that fails the file is removed again, so a failed ingestion leaves nothing behind.
 *
 * Per-user limits (documents, stored bytes, chunks per document) are checked before any paid work.
 * Ingestions of the same user run one at a time, otherwise two simultaneous uploads could both pass
 * the quota check; different users never wait for each other.
 */
export class IngestDocumentUseCase {
  private readonly userLocks = new KeyedMutex();

  constructor(private readonly deps: Dependencies) {}

  execute(input: IngestDocumentInput): Promise<IngestDocumentResult> {
    return this.userLocks.run(input.userId, () => this.ingest(input));
  }

  private async ingest(input: IngestDocumentInput): Promise<IngestDocumentResult> {
    const startedAt = Date.now();
    const { documents, files, extractor, embeddings, options } = this.deps;

    if (!isSupportedFileName(input.fileName)) {
      throw new ValidationError("Unsupported file type. Send PDF, MD, or TXT.");
    }
    if (input.data.byteLength === 0) {
      throw new ValidationError("The uploaded file is empty.");
    }
    if (input.data.byteLength > options.maxUploadBytes) {
      throw new ValidationError(`The file is too large. The limit is ${formatMegabytes(options.maxUploadBytes)}.`);
    }

    await this.assertWithinQuota(input.userId, input.data.byteLength);

    const text = normalizeText(await extractor.extract(input));
    if (!text) {
      throw new ValidationError("Could not extract text from the uploaded file.");
    }

    const drafts = splitText(text, { chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap });
    if (drafts.length === 0) {
      throw new ValidationError("The document does not contain enough text to index.");
    }

    if (drafts.length > options.maxChunksPerDocument) {
      throw new ValidationError(
        `This document is too large to index (it would need ${drafts.length} chunks; the limit is ${options.maxChunksPerDocument}). Try splitting it.`,
      );
    }

    const vectors = await embeddings.embedDocuments(drafts.map((draft) => draft.content));
    ensureEmbeddingBatch(vectors, drafts.length);

    const documentId = randomUUID();
    const createdAt = new Date().toISOString();
    const storedName = await files.save(input.fileName, input.data);

    const document: DocumentRecord = {
      id: documentId,
      userId: input.userId,
      fileName: input.fileName,
      storedName,
      mimeType: input.mimeType,
      fileSize: input.data.byteLength,
      textLength: text.length,
      summary: null,
      createdAt,
    };
    const chunks: ChunkRecord[] = drafts.map((draft, index) => ({
      id: randomUUID(),
      documentId,
      userId: input.userId,
      chunkIndex: draft.chunkIndex,
      content: draft.content,
      embedding: vectors[index],
      embeddingModel: embeddings.model,
      createdAt,
    }));

    try {
      await documents.saveWithChunks(document, chunks);
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
        textLength: text.length,
        durationMs: Date.now() - startedAt,
      },
      "Document ingested",
    );

    return { documentId, fileName: input.fileName, chunksCount: chunks.length, textLength: text.length };
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
