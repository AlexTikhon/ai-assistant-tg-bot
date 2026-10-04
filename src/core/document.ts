import { getFileExtension } from "../shared/utils/path.js";
import type { StoredIndexProfile } from "./index-profile.js";

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
};

/** A piece of a document as produced by the splitter, before it is embedded. */
export type ChunkDraft = {
  chunkIndex: number;
  content: string;
};

/** A persisted chunk together with the vector (and the model that produced it). */
export type ChunkRecord = {
  id: string;
  documentId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  /** Real page numbers (1-based) for paged formats (PDF); absent for text and for documents indexed before pages were tracked. */
  pageStart?: number;
  pageEnd?: number;
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
export type Citation = {
  documentId: string;
  fileName: string;
  chunkIndex: number;
  /** First/last page of the source text for PDFs; undefined when the document has no page information. */
  pageStart?: number;
  pageEnd?: number;
  /** 1-based position in the context the model saw - the number the answer cites as [n]. */
  rank: number;
  /** Fused retrieval score (reciprocal rank fusion): only meaningful relative to other sources. */
  score: number;
};
