import type Database from "better-sqlite3";
import type { ChunkRecord } from "../../core/document.js";
import { encodeVector } from "../../core/vectors.js";

const INSERT_CHUNK_SQL = `
  INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at)
  VALUES (@id, @documentId, @userId, @chunkIndex, @content, @embedding, @embeddingModel, @embeddingDim, @createdAt)`;

/** Plain insert: a duplicate (documentId, chunkIndex) is a bug and must fail the surrounding transaction. */
export function prepareChunkInsert(db: Database.Database) {
  const statement = db.prepare(INSERT_CHUNK_SQL);

  return (chunk: ChunkRecord) =>
    statement.run({
      id: chunk.id,
      documentId: chunk.documentId,
      userId: chunk.userId,
      chunkIndex: chunk.chunkIndex,
      content: chunk.content,
      embedding: encodeVector(chunk.embedding),
      embeddingModel: chunk.embeddingModel,
      embeddingDim: chunk.embedding.length,
      createdAt: chunk.createdAt,
    });
}
