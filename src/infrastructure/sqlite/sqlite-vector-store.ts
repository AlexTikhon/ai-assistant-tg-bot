import type Database from "better-sqlite3";
import type {
  EmbeddingUpdate,
  LexicalSearch,
  SimilaritySearch,
  VectorStore,
} from "../../application/ports/vector-store.js";
import type { ChunkText } from "../../core/document.js";
import type { SourceProvenance } from "../../core/provenance.js";
import type { StoredIndexProfile } from "../../core/index-profile.js";
import { buildLexicalQuery } from "../../core/lexical-query.js";
import type { ChunkMatch, StoredChunk } from "../../core/retrieval.js";
import { encodeVector } from "../../core/vectors.js";
import { logger } from "../../shared/logger.js";
import { profileColumns } from "./profile-column.js";
import { assertIndexRevision } from "./index-revision.js";
import type { IndexRevision } from "../../application/ports/document-repository.js";
import { operationSignal, throwIfCancelled } from "../../shared/operation.js";
import { scoreVectors, VECTOR_COLUMNS } from "./semantic-search.js";
import type { VectorRow } from "./semantic-search.js";
import type { SemanticScanner } from "./semantic-scanner.js";

type ChunkRow = Omit<StoredChunk, keyof SourceProvenance> & {
  pageStart: number | null;
  pageEnd: number | null;
  pageLabelStart: string | null;
  pageLabelEnd: string | null;
  sectionPath: string | null;
};

/** The stored JSON list of heading titles, or undefined when absent or not a list of strings (never an error). */
function parseSectionPath(json: string | null): string[] | undefined {
  if (json === null) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === "string") ? parsed : undefined;
  } catch {
    return undefined;
  }
}

type LexicalRow = {
  id: string;
  document_id: string;
  chunk_index: number;
  score: number;
};

const log = logger.child({ component: "sqlite-vector-store" });


// CROSS JOIN pins the order: the FTS index finds the matches first, then each is looked up by primary key
// and filtered by user. With a plain JOIN the planner may scan all of the user's chunks and repeat the
// full-text query per row (measured: ~170 ms instead of < 1 ms at 5000 chunks).
export const LEXICAL_SELECT = `SELECT c.id, c.document_id, c.chunk_index, -bm25(chunk_fts) AS score
  FROM chunk_fts CROSS JOIN document_chunks c ON c.seq = chunk_fts.rowid
  WHERE chunk_fts MATCH @match AND c.user_id = @userId`;


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
  private readonly updateProfile;
  private readonly replaceTransaction;

  constructor(db: Database.Database, private readonly scanner?: SemanticScanner) {
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
    this.selectChunks = db.prepare<[string, string], ChunkRow>(
      `SELECT c.id AS chunkId, c.document_id AS documentId, d.file_name AS fileName,
              c.chunk_index AS chunkIndex, c.content,
              c.page_start AS pageStart, c.page_end AS pageEnd,
              c.page_label_start AS pageLabelStart, c.page_label_end AS pageLabelEnd,
              c.section_path AS sectionPath
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
       WHERE user_id = @userId AND document_id = @documentId AND chunk_index = @chunkIndex
         AND (@chunkId IS NULL OR id = @chunkId)`,
    );
    this.updateProfile = db.prepare(
      `UPDATE documents SET index_profile = @indexProfile, index_fingerprint = @indexFingerprint
       WHERE user_id = @userId AND id = @documentId`,
    );
    this.replaceTransaction = db.transaction(
      (
        userId: string,
        documentId: string,
        model: string,
        encoded: Array<{ chunkIndex: number; chunkId: string | null; embedding: Buffer; dimension: number }>,
        profile?: StoredIndexProfile,
        expectedRevision?: IndexRevision,
      ) => {
        assertIndexRevision(db, userId, documentId, expectedRevision);
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
        if (profile) {
          this.updateProfile.run({ userId, documentId, ...profileColumns(profile) });
        }
        db.prepare("UPDATE documents SET index_revision = index_revision + 1 WHERE user_id = ? AND id = ?").run(userId, documentId);
      },
    );
  }

  async searchSimilar(search: SimilaritySearch): Promise<ChunkMatch[]> {
    throwIfCancelled();
    if (this.scanner) {
      const result = await this.scanner.search(search, operationSignal());
      throwIfCancelled();
      this.warnAboutSkippedChunks(search, result.unusable);
      return result.matches;
    }
    const params = {
      userId: search.userId,
      embeddingModel: search.embeddingModel,
      ...(search.documentId ? { documentId: search.documentId } : {}),
    };
    const rows = (search.documentId ? this.selectDocumentVectors : this.selectVectors).iterate(params);

    const result = scoreVectors(rows, search, throwIfCancelled);
    this.warnAboutSkippedChunks(search, result.unusable);
    return result.matches;
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
    return this.selectChunks
      .all(userId, JSON.stringify(chunkIds))
      .map(({ pageStart, pageEnd, pageLabelStart, pageLabelEnd, sectionPath, ...chunk }) => {
        const section = parseSectionPath(sectionPath);
        return {
          ...chunk,
          ...(pageStart !== null && pageEnd !== null ? { pageStart, pageEnd } : {}),
          // Labels only make sense next to pages, and only when both ends are known.
          ...(pageStart !== null && pageEnd !== null && pageLabelStart !== null && pageLabelEnd !== null ? { pageLabelStart, pageLabelEnd } : {}),
          ...(section ? { sectionPath: section } : {}),
        };
      });
  }

  async listByDocument(userId: string, documentId: string): Promise<ChunkText[]> {
    return this.selectText.all(userId, documentId);
  }

  async replaceEmbeddings(
    userId: string,
    documentId: string,
    model: string,
    updates: EmbeddingUpdate[],
    profile?: StoredIndexProfile,
    expectedRevision?: IndexRevision,
  ) {
    throwIfCancelled();
    if (new Set(updates.map((update) => update.chunkIndex)).size !== updates.length) {
      throw new Error("Duplicate chunk positions in embedding updates");
    }
    // Encoding validates every vector before the transaction starts.
    const encoded = updates.map((update) => ({
      chunkIndex: update.chunkIndex,
      chunkId: update.chunkId ?? null,
      embedding: encodeVector(update.embedding),
      dimension: update.embedding.length,
    }));
    this.replaceTransaction(userId, documentId, model, encoded, profile, expectedRevision);
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
