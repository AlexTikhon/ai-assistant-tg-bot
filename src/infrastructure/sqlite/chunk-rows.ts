import type Database from "better-sqlite3";
import type { ChunkRecord } from "../../core/document.js";
import { encodeVector } from "../../core/vectors.js";

const INSERT_CHUNK_SQL = `
  INSERT INTO document_chunks (id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, page_start, page_end, created_at)
  VALUES (@id, @documentId, @userId, @chunkIndex, @content, @embedding, @embeddingModel, @embeddingDim, @pageStart, @pageEnd, @createdAt)`;

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
      pageStart: chunk.pageStart ?? null,
      pageEnd: chunk.pageEnd ?? null,
      createdAt: chunk.createdAt,
    });
}
