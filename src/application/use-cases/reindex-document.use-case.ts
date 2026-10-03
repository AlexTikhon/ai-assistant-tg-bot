import { randomUUID } from "node:crypto";
import type { ChunkRecord } from "../../core/document.js";
import { NotFoundError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { ensureEmbeddingBatch } from "../validate-embeddings.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { VectorStore } from "../ports/vector-store.js";

type Dependencies = {
  documents: DocumentRepository;
  vectorStore: VectorStore;
  embeddings: EmbeddingsProvider;
};

const log = logger.child({ operation: "reindexDocument" });

/**
 * Re-embeds a document's stored chunks with the currently configured embeddings model.
 *
 * Chunks embedded with another model are ignored by search, so after changing
 * OPENAI_EMBEDDINGS_MODEL this is how existing documents become searchable again. It is not exposed
 * in Telegram; a script or admin command can call it per document.
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

    const createdAt = new Date().toISOString();
    const chunks: ChunkRecord[] = texts.map((text, index) => ({
      id: randomUUID(),
      documentId,
      userId,
      chunkIndex: text.chunkIndex,
      content: text.content,
      embedding: vectors[index],
      embeddingModel: embeddings.model,
      createdAt,
    }));
    await vectorStore.upsertChunks(chunks);

    log.info({ userId, documentId, chunks: chunks.length, embeddingModel: embeddings.model }, "Document re-indexed");
    return { chunksCount: chunks.length };
  }
}
