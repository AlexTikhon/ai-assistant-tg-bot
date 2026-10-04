import type { SourceProvenance } from "./provenance.js";

/** A chunk found by one retrieval method. Lists of matches are ordered best first. */
export type ChunkMatch = {
  chunkId: string;
  documentId: string;
  chunkIndex: number;
  /** Method specific (cosine similarity, negated BM25): comparable only within one list. */
  score: number;
};

/** Why a chunk made it into the candidate list; explains retrieval, never shown to normal users. */
export type RetrievalRanking = {
  /** 1-based position in the fused candidate list. */
  fusedRank: number;
  fusedScore: number;
  /** Position/score in the vector ranking; absent when the chunk was not a semantic candidate. */
  semanticRank?: number;
  semanticScore?: number;
  /** Position and score (negated BM25, higher is better) in the full-text ranking; absent when the chunk was not a lexical candidate. */
  lexicalRank?: number;
  lexicalScore?: number;
  /** How many of the question's exact targets (identifiers, file names, ...) the chunk contains; set only when an exact-token bonus was applied. */
  exactMatches?: number;
};

/** A chunk's text and the document it belongs to. Provenance parts are absent when unknown. */
export type StoredChunk = SourceProvenance & {
  chunkId: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  content: string;
};

/** A candidate chunk ready to become LLM context, with the reason it was retrieved. */
export type RetrievedChunk = StoredChunk & {
  ranking: RetrievalRanking;
};
