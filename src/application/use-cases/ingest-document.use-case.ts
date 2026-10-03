import { randomUUID } from "node:crypto";
import { isSupportedFileName } from "../../core/document.js";
import type { ChunkRecord, DocumentRecord } from "../../core/document.js";
import { splitText } from "../../core/text-splitter.js";
import { ValidationError } from "../../shared/errors.js";
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
  options: { maxUploadBytes: number; chunkSize: number; chunkOverlap: number };
};

const log = logger.child({ operation: "ingestDocument" });

/**
 * Turns an uploaded file into a searchable document.
 *
 * All fallible work that has no side effects (validation, extraction, splitting, embedding) happens
 * first. Only then is the file written, and the metadata + chunks are saved in one transaction. If
 * that fails the file is removed again, so a failed ingestion leaves nothing behind.
 */
export class IngestDocumentUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(input: IngestDocumentInput): Promise<IngestDocumentResult> {
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

    const text = normalizeText(await extractor.extract(input));
    if (!text) {
      throw new ValidationError("Could not extract text from the uploaded file.");
    }

    const drafts = splitText(text, { chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap });
    if (drafts.length === 0) {
      throw new ValidationError("The document does not contain enough text to index.");
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
}

function formatMegabytes(bytes: number) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}
