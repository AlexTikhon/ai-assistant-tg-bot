import type Database from "better-sqlite3";
import type { ChunkRecord } from "../../core/document.js";

const COLUMNS = "id, document_id, user_id, chunk_index, content, embedding, embedding_model, embedding_dim, created_at";
const VALUES = "@id, @documentId, @userId, @chunkIndex, @content, @embedding, @embeddingModel, @embeddingDim, @createdAt";

const INSERT_CHUNK_SQL = `INSERT INTO document_chunks (${COLUMNS}) VALUES (${VALUES})`;

const UPSERT_CHUNK_SQL = `${INSERT_CHUNK_SQL}
  ON CONFLICT (document_id, chunk_index) DO UPDATE SET
    content = excluded.content,
    embedding = excluded.embedding,
    embedding_model = excluded.embedding_model,
    embedding_dim = excluded.embedding_dim`;

function toParams(chunk: ChunkRecord) {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    userId: chunk.userId,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    embedding: JSON.stringify(chunk.embedding),
    embeddingModel: chunk.embeddingModel,
    embeddingDim: chunk.embedding.length,
    createdAt: chunk.createdAt,
  };
}

/** Plain insert: a duplicate (documentId, chunkIndex) is a bug and must fail the surrounding transaction. */
export function prepareChunkInsert(db: Database.Database) {
  const statement = db.prepare(INSERT_CHUNK_SQL);
  return (chunk: ChunkRecord) => statement.run(toParams(chunk));
}

/** Insert-or-replace for re-indexing existing documents. */
export function prepareChunkUpsert(db: Database.Database) {
  const statement = db.prepare(UPSERT_CHUNK_SQL);
  return (chunk: ChunkRecord) => statement.run(toParams(chunk));
}
