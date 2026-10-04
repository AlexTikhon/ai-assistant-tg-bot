import { NotFoundError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { VectorStore } from "../ports/vector-store.js";
import { ensureEmbeddingBatch } from "../validate-embeddings.js";

type Dependencies = {
  documents: DocumentRepository;
  vectorStore: VectorStore;
  embeddings: EmbeddingsProvider;
};

const log = logger.child({ operation: "reindexDocument" });

/**
 * Re-embeds a document's stored chunks with the currently configured embeddings model.
 *
 * Reuses the persisted chunk text (the original file is not re-read), so the existing chunking is
 * kept: a changed CHUNK_SIZE/CHUNK_OVERLAP only affects documents uploaded afterwards. All vectors
 * are computed first and then swapped in one transaction, so a failure at any point leaves the
 * document exactly as it was.
 */
export class ReindexDocumentUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(userId: string, documentId: string): Promise<{ chunksCount: number }> {
    const { documents, vectorStore, embeddings } = this.deps;

    if (!(await documents.findById(userId, documentId))) {
      throw new NotFoundError();
    }

    const texts = await vectorStore.listByDocument(userId, documentId);
    if (texts.length === 0) {
      return { chunksCount: 0 };
    }

    const vectors = await embeddings.embedDocuments(texts.map((text) => text.content));
    ensureEmbeddingBatch(vectors, texts.length);

    await vectorStore.replaceEmbeddings(
      userId,
      documentId,
      embeddings.model,
      texts.map((text, index) => ({ chunkIndex: text.chunkIndex, embedding: vectors[index] })),
    );

    log.info({ userId, documentId, chunks: texts.length, embeddingModel: embeddings.model }, "Document re-indexed");
    return { chunksCount: texts.length };
  }
}
