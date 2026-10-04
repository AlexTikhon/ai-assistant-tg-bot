import type Database from "better-sqlite3";
import type { EmbeddingTarget, IndexedDocument, IndexMaintenance } from "../../application/ports/index-maintenance.js";
import { legacyIndexProfile } from "../../core/index-profile.js";
import { parseProfileColumn } from "./profile-column.js";

/** A vector is stale when it came from another model, is unreadable, or has an unexpected dimension. */
const STALE_CHUNK = `(c.embedding_model != @model
  OR c.embedding_dim <= 0
  OR length(c.embedding) != c.embedding_dim * 4
  OR (@dimension IS NOT NULL AND c.embedding_dim != @dimension))`;

type Row = Omit<IndexedDocument, "storedProfile"> & {
  profileJson: string | null;
  vectorModel: string | null;
  vectorDimension: number | null;
};

/** Cross-user statistics about the index, for re-indexing and startup diagnostics. */
export class SqliteIndexMaintenance implements IndexMaintenance {
  private readonly selectDocuments;

  constructor(db: Database.Database) {
    this.selectDocuments = db.prepare<{ model: string; dimension: number | null }, Row>(
      `SELECT d.user_id AS userId, d.id AS documentId, d.file_name AS fileName, d.index_profile AS profileJson,
              COUNT(c.seq) AS chunkCount,
              COALESCE(SUM(CASE WHEN ${STALE_CHUNK} THEN 1 ELSE 0 END), 0) AS staleChunkCount,
              MIN(c.embedding_model) AS vectorModel, MAX(c.embedding_dim) AS vectorDimension
       FROM documents d
       LEFT JOIN document_chunks c ON c.document_id = d.id AND c.user_id = d.user_id
       GROUP BY d.id
       ORDER BY d.created_at, d.id`,
    );
  }

  async listIndexedDocuments(target: EmbeddingTarget): Promise<IndexedDocument[]> {
    return this.selectDocuments
      .all({ model: target.model, dimension: target.dimension ?? null })
      .map(({ profileJson, vectorModel, vectorDimension, ...document }) => {
        // The chunks are the truth for what search compares against; the recorded profile supplies the rest.
        const recorded =
          parseProfileColumn(profileJson) ??
          legacyIndexProfile(document.fileName, vectorModel ?? "", vectorDimension ?? 0);
        const storedProfile =
          vectorModel === null
            ? recorded
            : { ...recorded, embeddingModel: vectorModel, embeddingDimension: vectorDimension ?? 0 };
        return { ...document, storedProfile };
      });
  }
}
