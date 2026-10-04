import { NotFoundError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { toChunkRecords, prepareIndex } from "../prepare-index.js";
import type { PrepareIndexOptions } from "../prepare-index.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { FileStorage } from "../ports/file-storage.js";
import type { DocumentTextExtractor } from "../ports/text-extractor.js";

type Dependencies = {
  documents: DocumentRepository;
  files: FileStorage;
  extractor: DocumentTextExtractor;
  embeddings: EmbeddingsProvider;
  options: PrepareIndexOptions;
};

const log = logger.child({ operation: "rechunkDocument" });

/**
 * Rebuilds a document's index from its original file with the current settings: extraction, chunking
 * (CHUNK_SIZE / CHUNK_OVERLAP / algorithm), page provenance and embeddings.
 *
 * Nothing existing is touched until the replacement is complete. Reading the file, extracting, splitting
 * and embedding (the only step that costs money and can fail halfway) all happen first and only read;
 * the old chunks are then swapped for the new ones, together with the recorded index profile, in a single
 * SQLite transaction (the full-text index follows through its triggers). A failure at any point - including
 * inside that transaction - leaves the previous chunks, vectors, profile and file exactly as they were.
 * The original file, the document row and its summary are never modified.
 */
export class RechunkDocumentUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(userId: string, documentId: string): Promise<{ chunksCount: number }> {
    const { documents, files, extractor, embeddings, options } = this.deps;

    const document = await documents.findById(userId, documentId);
    if (!document) {
      throw new NotFoundError();
    }

    const data = await files.read(document.storedName);
    const prepared = await prepareIndex(
      { extractor, embeddings },
      { fileName: document.fileName, mimeType: document.mimeType, data },
      options,
    );

    await documents.replaceChunks(userId, documentId, {
      chunks: toChunkRecords(prepared, { documentId, userId, createdAt: new Date().toISOString() }),
      indexProfile: prepared.profile,
      textLength: prepared.textLength,
    });

    log.info(
      { userId, documentId, chunks: prepared.chunks.length, chunkSize: options.chunkSize, embeddingModel: embeddings.model },
      "Document re-chunked",
    );
    return { chunksCount: prepared.chunks.length };
  }
}
