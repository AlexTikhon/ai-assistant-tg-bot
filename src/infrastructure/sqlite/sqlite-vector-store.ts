import type Database from "better-sqlite3";
import type {
  EmbeddingUpdate,
  LexicalSearch,
  SimilaritySearch,
  VectorStore,
} from "../../application/ports/vector-store.js";
import type { ChunkText } from "../../core/document.js";
import { buildLexicalQuery } from "../../core/lexical-query.js";
import type { ChunkMatch, StoredChunk } from "../../core/retrieval.js";
import { cosineSimilarity, decodeVector, encodeVector, VectorError } from "../../core/vectors.js";
import { logger } from "../../shared/logger.js";

/** Only what scoring needs: no chunk text is read while ranking. */
type VectorRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  embedding: Buffer;
  embedding_dim: number;
};

type LexicalRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  score: number;
};

const log = logger.child({ component: "sqlite-vector-store" });

const VECTOR_COLUMNS = `SELECT id, document_id, chunk_index, embedding, embedding_dim FROM document_chunks
  WHERE user_id = @userId AND embedding_model = @embeddingModel`;

// CROSS JOIN pins the order: the FTS index finds the matches first, then each is looked up by primary key
// and filtered by user. With a plain JOIN the planner may scan all of the user's chunks and repeat the
// full-text query per row (measured: ~170 ms instead of < 1 ms at 5000 chunks).
export const LEXICAL_SELECT = `SELECT c.id, c.document_id, c.chunk_index, -bm25(chunk_fts) AS score
  FROM chunk_fts CROSS JOIN document_chunks c ON c.seq = chunk_fts.rowid
  WHERE chunk_fts MATCH @match AND c.user_id = @userId`;

function byScore(a: ChunkMatch, b: ChunkMatch) {
  return b.score - a.score || a.documentId.localeCompare(b.documentId) || a.chunkIndex - b.chunkIndex;
}

/**
 * Chunk search in SQLite.
 *
 * Semantic: brute-force cosine over float32 blobs. Ranking reads only ids, positions and vectors;
 * chunk text is fetched afterwards for the few final candidates (`getChunks`). Only chunks produced
 * by the same embedding model - and of the same dimension - as the query are ever compared.
 * Lexical: FTS5 (BM25) over the same chunks, filtered by user.
 */
export class SqliteVectorStore implements VectorStore {
  private readonly selectVectors;
  private readonly selectDocumentVectors;
  private readonly selectLexical;
  private readonly selectDocumentLexical;
  private readonly selectChunks;
  private readonly selectText;
  private readonly deleteChunks;
  private readonly countOtherModels;
  private readonly countChunks;
  private readonly updateEmbedding;
  private readonly replaceTransaction;

  constructor(db: Database.Database) {
    this.selectVectors = db.prepare<Record<string, string>, VectorRow>(VECTOR_COLUMNS);
    this.selectDocumentVectors = db.prepare<Record<string, string>, VectorRow>(
      `${VECTOR_COLUMNS} AND document_id = @documentId`,
    );
    this.selectLexical = db.prepare<Record<string, string | number>, LexicalRow>(
      `${LEXICAL_SELECT} ORDER BY bm25(chunk_fts) LIMIT @limit`,
    );
    this.selectDocumentLexical = db.prepare<Record<string, string | number>, LexicalRow>(
      `${LEXICAL_SELECT} AND c.document_id = @documentId ORDER BY bm25(chunk_fts) LIMIT @limit`,
    );
    this.selectChunks = db.prepare<[string, string], StoredChunk>(
      `SELECT c.id AS chunkId, c.document_id AS documentId, d.file_name AS fileName,
              c.chunk_index AS chunkIndex, c.content
       FROM document_chunks c
       JOIN documents d ON d.id = c.document_id AND d.user_id = c.user_id
       WHERE c.user_id = ? AND c.id IN (SELECT value FROM json_each(?))`,
    );
    this.selectText = db.prepare<[string, string], ChunkText>(
      `SELECT chunk_index AS chunkIndex, content
       FROM document_chunks WHERE user_id = ? AND document_id = ? ORDER BY chunk_index`,
    );
    this.deleteChunks = db.prepare("DELETE FROM document_chunks WHERE user_id = ? AND document_id = ?");
    this.countOtherModels = db.prepare<[string, string], { count: number }>(
      "SELECT COUNT(*) AS count FROM document_chunks WHERE user_id = ? AND embedding_model != ?",
    );
    this.countChunks = db.prepare<[string, string], { count: number }>(
      "SELECT COUNT(*) AS count FROM document_chunks WHERE user_id = ? AND document_id = ?",
    );
    this.updateEmbedding = db.prepare(
      `UPDATE document_chunks
       SET embedding = @embedding, embedding_model = @model, embedding_dim = @dimension
       WHERE user_id = @userId AND document_id = @documentId AND chunk_index = @chunkIndex`,
    );
    this.replaceTransaction = db.transaction(
      (
        userId: string,
        documentId: string,
        model: string,
        encoded: Array<{ chunkIndex: number; embedding: Buffer; dimension: number }>,
      ) => {
        const stored = this.countChunks.get(userId, documentId)?.count ?? 0;
        if (stored !== encoded.length) {
          throw new Error(`Document has ${stored} chunks but ${encoded.length} embeddings were supplied`);
        }
        for (const update of encoded) {
          const result = this.updateEmbedding.run({ userId, documentId, model, ...update });
          if (result.changes !== 1) {
            throw new Error(`Chunk ${update.chunkIndex} does not exist in the document`);
          }
        }
      },
    );
  }

  async searchSimilar(search: SimilaritySearch): Promise<ChunkMatch[]> {
    const params = {
      userId: search.userId,
      embeddingModel: search.embeddingModel,
      ...(search.documentId ? { documentId: search.documentId } : {}),
    };
    const rows = (search.documentId ? this.selectDocumentVectors : this.selectVectors).iterate(params);

    const matches: ChunkMatch[] = [];
    let unusable = 0;

    for (const row of rows) {
      if (row.embedding_dim !== search.embedding.length) {
        unusable += 1;
        continue;
      }

      try {
        const score = cosineSimilarity(search.embedding, decodeVector(row.embedding));
        if (score >= search.minScore) {
          matches.push({ chunkId: row.id, documentId: row.document_id, chunkIndex: row.chunk_index, score });
        }
      } catch (error) {
        if (!(error instanceof VectorError)) {
          throw error;
        }
        unusable += 1;
      }
    }

    this.warnAboutSkippedChunks(search, unusable);

    return matches.sort(byScore).slice(0, search.limit);
  }

  async searchLexical(search: LexicalSearch): Promise<ChunkMatch[]> {
    const match = buildLexicalQuery(search.query);
    if (!match) {
      return [];
    }

    const params = {
      match,
      userId: search.userId,
      limit: search.limit,
      ...(search.documentId ? { documentId: search.documentId } : {}),
    };
    const rows = (search.documentId ? this.selectDocumentLexical : this.selectLexical).all(params);

    return rows.map((row) => ({
      chunkId: row.id,
      documentId: row.document_id,
      chunkIndex: row.chunk_index,
      score: row.score,
    }));
  }

  async getChunks(userId: string, chunkIds: string[]): Promise<StoredChunk[]> {
    if (chunkIds.length === 0) {
      return [];
    }
    return this.selectChunks.all(userId, JSON.stringify(chunkIds));
  }

  async listByDocument(userId: string, documentId: string): Promise<ChunkText[]> {
    return this.selectText.all(userId, documentId);
  }

  async replaceEmbeddings(userId: string, documentId: string, model: string, updates: EmbeddingUpdate[]) {
    // Encoding validates every vector before the transaction starts.
    const encoded = updates.map((update) => ({
      chunkIndex: update.chunkIndex,
      embedding: encodeVector(update.embedding),
      dimension: update.embedding.length,
    }));
    this.replaceTransaction(userId, documentId, model, encoded);
  }

  async deleteByDocument(userId: string, documentId: string) {
    this.deleteChunks.run(userId, documentId);
  }

  private warnAboutSkippedChunks(search: SimilaritySearch, unusable: number) {
    const otherModel = this.countOtherModels.get(search.userId, search.embeddingModel)?.count ?? 0;
    if (unusable > 0 || otherModel > 0) {
      log.warn(
        { userId: search.userId, embeddingModel: search.embeddingModel, otherModel, unusable },
        "Skipped chunks that are incompatible with the query embedding; re-index the affected documents",
      );
    }
  }
}
