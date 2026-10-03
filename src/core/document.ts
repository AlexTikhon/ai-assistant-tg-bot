import { getFileExtension } from "../shared/utils/path.js";

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
  embedding: number[];
  embeddingModel: string;
  createdAt: string;
};

/** Chunk text without its vector - what summarization and re-indexing need. */
export type ChunkText = {
  chunkIndex: number;
  content: string;
};

/** A chunk returned by similarity search, enriched with the source document info. */
export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  content: string;
  score: number;
};

/** Where part of an answer came from. Presentation is up to the caller. */
export type Citation = {
  documentId: string;
  fileName: string;
  chunkIndex: number;
  score: number;
};
