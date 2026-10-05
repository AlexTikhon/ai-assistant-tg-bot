import { getFileExtension } from "../shared/utils/path.js";
import type { StoredIndexProfile } from "./index-profile.js";
import type { SourceProvenance } from "./provenance.js";

/** File extensions the ingestion pipeline can extract text from. */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([".pdf", ".md", ".txt"]);

export function isSupportedFileName(fileName: string) {
  return SUPPORTED_EXTENSIONS.has(getFileExtension(fileName));
}

/** Metadata of an uploaded document. Always owned by exactly one Telegram user. */
export type DocumentRecord = {
  id: string;
  userId: string;
  fileName: string;
  storedName: string;
  mimeType: string;
  fileSize: number;
  textLength: number;
  summary: string | null;
  createdAt: string;
  /**
   * The recipe this document was indexed with. null (or absent on input) for documents indexed before
   * recipes were recorded; maintenance describes those from what is known (see IndexMaintenance).
   */
  indexProfile?: StoredIndexProfile | null;
  /**
   * SHA-256 of the original bytes (see content-hash.ts). null = unknown: the document was stored before
   * hashes were recorded and has not been backfilled yet. Absent on input means unknown.
   */
  contentHash?: string | null;
  /** 1 for a new document; +1 for every explicit replacement of its content. Absent on input means 1. */
  documentVersion?: number;
  /** Incremented whenever the content, chunk layout or embeddings change. */
  indexRevision?: number;
  /** When the content or the index was last rebuilt (replacement, re-chunk). null/absent: never since it was created. */
  updatedAt?: string | null;
  /** Content hash before the last replacement; null when the document was never replaced. */
  previousContentHash?: string | null;
};

/** A piece of a document as produced by the splitter, before it is embedded. */
export type ChunkDraft = {
  chunkIndex: number;
  content: string;
};

/** A persisted chunk together with the vector (and the model that produced it). */
export type ChunkRecord = SourceProvenance & {
  id: string;
  documentId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  embeddingModel: string;
  createdAt: string;
};

/** Chunk text without its vector - what summarization and re-indexing need. */
export type ChunkText = {
  chunkIndex: number;
  content: string;
};

/** Where part of an answer came from. Presentation is up to the caller. */
export type Citation = SourceProvenance & {
  documentId: string;
  fileName: string;
  chunkIndex: number;
  /** 1-based position in the context the model saw - the number the answer cites as [n]. */
  rank: number;
  /** Fused retrieval score (reciprocal rank fusion): only meaningful relative to other sources. */
  score: number;
};
