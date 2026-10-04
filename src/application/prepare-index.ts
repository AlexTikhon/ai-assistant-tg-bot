import { randomUUID } from "node:crypto";
import type { ChunkRecord } from "../core/document.js";
import { buildIndexProfile } from "../core/index-profile.js";
import type { IndexProfile } from "../core/index-profile.js";
import { getFileExtension } from "../shared/utils/path.js";
import { parseMarkdownHeadings, sectionPathForRange } from "../core/markdown-sections.js";
import { buildDocumentText, pageRangeForSpan } from "../core/pages.js";
import type { SourceProvenance } from "../core/provenance.js";
import { splitTextWithOffsets } from "../core/text-splitter.js";
import { ValidationError } from "../shared/errors.js";
import type { EmbeddingsProvider } from "./ports/embeddings-provider.js";
import type { DocumentTextExtractor, ExtractionInput } from "./ports/text-extractor.js";
import { ensureEmbeddingBatch } from "./validate-embeddings.js";

export type PrepareIndexOptions = {
  chunkSize: number;
  chunkOverlap: number;
  maxChunksPerDocument: number;
};

/** Everything needed to persist a document's index; nothing has been written yet. */
export type PreparedIndex = {
  textLength: number;
  profile: IndexProfile;
  /** Chunks with their vectors and provenance (pages, section path); callers add ids, owner and timestamp. */
  chunks: Array<{ chunkIndex: number; content: string; embedding: number[] } & SourceProvenance>;
  embeddingModel: string;
};

/**
 * The side-effect free half of indexing, shared by ingestion and re-chunking so both always produce
 * the same thing: extract -> normalize -> split (remembering where each chunk came from) -> check the
 * chunk limit -> embed -> validate the vectors. It only reads and calls the embeddings provider; the
 * caller decides how the result is persisted. Any failure here leaves the caller with nothing to undo.
 */
export async function prepareIndex(
  deps: { extractor: DocumentTextExtractor; embeddings: EmbeddingsProvider },
  input: ExtractionInput,
  options: PrepareIndexOptions,
): Promise<PreparedIndex> {
  const { extractor, embeddings } = deps;

  const { text, pageSpans } = buildDocumentText(await extractor.extract(input));
  if (!text) {
    throw new ValidationError("Could not extract text from the uploaded file.");
  }

  const drafts = splitTextWithOffsets(text, { chunkSize: options.chunkSize, chunkOverlap: options.chunkOverlap });
  if (drafts.length === 0) {
    throw new ValidationError("The document does not contain enough text to index.");
  }
  if (drafts.length > options.maxChunksPerDocument) {
    throw new ValidationError(
      `This document is too large to index (it would need ${drafts.length} chunks; the limit is ${options.maxChunksPerDocument}). Try splitting it.`,
    );
  }

  // Markdown only (by extension): the headings of the normalized text, whose offsets are those of the splitter.
  const headings = getFileExtension(input.fileName) === ".md" ? parseMarkdownHeadings(text) : [];

  const vectors = await embeddings.embedDocuments(drafts.map((draft) => draft.content));
  ensureEmbeddingBatch(vectors, drafts.length);

  return {
    textLength: text.length,
    embeddingModel: embeddings.model,
    profile: buildIndexProfile({
      fileName: input.fileName,
      embeddingModel: embeddings.model,
      embeddingDimension: vectors[0].length,
      chunkSize: options.chunkSize,
      chunkOverlap: options.chunkOverlap,
    }),
    chunks: drafts.map((draft, index) => {
      const sectionPath = sectionPathForRange(headings, draft.start, draft.end);
      return {
        chunkIndex: draft.chunkIndex,
        content: draft.content,
        embedding: vectors[index],
        ...pageRangeForSpan(pageSpans, draft.start, draft.end),
        // No heading above the chunk (or no Markdown at all): no section, rather than an invented one.
        ...(sectionPath.length > 0 ? { sectionPath } : {}),
      };
    }),
  };
}

/** Turns prepared chunks into rows for one document, with fresh ids. */
export function toChunkRecords(
  prepared: PreparedIndex,
  owner: { documentId: string; userId: string; createdAt: string },
): ChunkRecord[] {
  return prepared.chunks.map((chunk) => ({
    id: randomUUID(),
    ...owner,
    ...chunk,
    embeddingModel: prepared.embeddingModel,
  }));
}
