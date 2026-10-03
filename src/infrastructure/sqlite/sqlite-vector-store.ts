import type Database from "better-sqlite3";
import type { SimilaritySearch, VectorStore } from "../../application/ports/vector-store.js";
import type { ChunkRecord, ChunkText, RetrievedChunk } from "../../core/document.js";
import { cosineSimilarity, VectorError } from "../../core/vectors.js";
import { logger } from "../../shared/logger.js";
import { prepareChunkUpsert } from "./chunk-rows.js";

type CandidateRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  embedding: string;
  embedding_dim: number;
  file_name: string;
};

const log = logger.child({ component: "sqlite-vector-store" });

function parseEmbedding(json: string): number[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) {
      return parsed as number[];
    }
  } catch {
    // handled below
  }
  throw new VectorError("Stored embedding is not a valid JSON array");
}

/**
 * Brute-force cosine search over vectors stored as JSON in SQLite.
 *
 * Fine for personal knowledge bases (thousands of chunks). Only chunks produced by the same
 * embedding model - and of the same dimension - as the query are ever compared.
 */
export class SqliteVectorStore implements VectorStore {
  private readonly upsertChunk;
  private readonly upsertTransaction;
  private readonly selectText;
  private readonly deleteChunks;
  private readonly countIncompatible;

  constructor(private readonly db: Database.Database) {
    this.upsertChunk = prepareChunkUpsert(db);
    this.upsertTransaction = db.transaction((chunks: ChunkRecord[]) => {
      for (const chunk of chunks) {
        this.upsertChunk(chunk);
      }
    });
    this.selectText = db.prepare<[string, string], ChunkText>(
      `SELECT chunk_index AS chunkIndex, content
       FROM document_chunks WHERE user_id = ? AND document_id = ? ORDER BY chunk_index`,
    );
    this.deleteChunks = db.prepare("DELETE FROM document_chunks WHERE user_id = ? AND document_id = ?");
    this.countIncompatible = db.prepare<[string, string], { count: number }>(
      "SELECT COUNT(*) AS count FROM document_chunks WHERE user_id = ? AND embedding_model != ?",
    );
  }

  async upsertChunks(chunks: ChunkRecord[]) {
    this.upsertTransaction(chunks);
  }

  async searchSimilar(search: SimilaritySearch): Promise<RetrievedChunk[]> {
    const rows = this.db
      .prepare<Record<string, string>, CandidateRow>(
        `SELECT c.id, c.document_id, c.chunk_index, c.content, c.embedding, c.embedding_dim, d.file_name
         FROM document_chunks c
         JOIN documents d ON d.id = c.document_id AND d.user_id = c.user_id
         WHERE c.user_id = @userId
           AND c.embedding_model = @embeddingModel
           ${search.documentId ? "AND c.document_id = @documentId" : ""}`,
      )
      .all({
        userId: search.userId,
        embeddingModel: search.embeddingModel,
        ...(search.documentId ? { documentId: search.documentId } : {}),
      });

    const results: RetrievedChunk[] = [];
    let corrupted = 0;

    for (const row of rows) {
      if (row.embedding_dim !== search.embedding.length) {
        corrupted += 1;
        continue;
      }

      try {
        const score = cosineSimilarity(search.embedding, parseEmbedding(row.embedding));
        if (score >= search.minScore) {
          results.push({
            chunkId: row.id,
            documentId: row.document_id,
            fileName: row.file_name,
            chunkIndex: row.chunk_index,
            content: row.content,
            score,
          });
        }
      } catch (error) {
        if (!(error instanceof VectorError)) {
          throw error;
        }
        corrupted += 1;
      }
    }

    this.warnAboutSkippedChunks(search, corrupted);

    return results
      .sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId) || a.chunkIndex - b.chunkIndex)
      .slice(0, search.topK);
  }

  async listByDocument(userId: string, documentId: string): Promise<ChunkText[]> {
    return this.selectText.all(userId, documentId);
  }

  async deleteByDocument(userId: string, documentId: string) {
    this.deleteChunks.run(userId, documentId);
  }

  private warnAboutSkippedChunks(search: SimilaritySearch, unusable: number) {
    const otherModel = this.countIncompatible.get(search.userId, search.embeddingModel)?.count ?? 0;
    if (unusable > 0 || otherModel > 0) {
      log.warn(
        { userId: search.userId, embeddingModel: search.embeddingModel, otherModel, unusable },
        "Skipped chunks that are incompatible with the query embedding; re-index the affected documents",
      );
    }
  }
}
