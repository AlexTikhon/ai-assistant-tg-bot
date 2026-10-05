import { legacyIndexProfile } from "../../core/index-profile.js";
import { NotFoundError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { VectorStore } from "../ports/vector-store.js";
import { ensureEmbeddingBatch } from "../validate-embeddings.js";
import { operationSignal, operationStep } from "../../shared/operation.js";

type Dependencies = {
  documents: DocumentRepository;
  vectorStore: VectorStore;
  embeddings: EmbeddingsProvider;
};

const log = logger.child({ operation: "reindexDocument" });

/**
 * Re-embeds a document's stored chunks with the currently configured embeddings model ("re-embed").
 *
 * Reuses the persisted chunk text and ids - the original file is not re-read and nothing is re-split, so
 * the chunk layout and extraction stay as they were (use RechunkDocumentUseCase for those). All vectors
 * are computed first and then swapped in one transaction together with the recorded embedding model and
 * dimension, so a failure at any point leaves the document exactly as it was.
 */
export class ReindexDocumentUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(userId: string, documentId: string): Promise<{ chunksCount: number }> {
    const { documents, vectorStore, embeddings } = this.deps;

    const snapshot = await documents.readIndexSnapshot(userId, documentId);
    if (!snapshot) {
      throw new NotFoundError();
    }

    const { document, chunks: texts, revision } = snapshot;
    if (texts.length === 0) {
      return { chunksCount: 0 };
    }

    const vectors = await operationStep(() => embeddings.embedDocuments(texts.map((text) => text.content), { signal: operationSignal() }));
    ensureEmbeddingBatch(vectors, texts.length);

    // Only the embedding half of the recipe changes; chunk size, overlap and extractor are carried over.
    const recorded = document.indexProfile ?? legacyIndexProfile(document.fileName, embeddings.model, vectors[0].length);

    await vectorStore.replaceEmbeddings(
      userId,
      documentId,
      embeddings.model,
      texts.map((text, index) => ({ chunkIndex: text.chunkIndex, chunkId: text.chunkId, embedding: vectors[index] })),
      { ...recorded, embeddingModel: embeddings.model, embeddingDimension: vectors[0].length },
      revision,
    );

    log.info({ userId, documentId, chunks: texts.length, embeddingModel: embeddings.model }, "Document re-indexed");
    return { chunksCount: texts.length };
  }
}
