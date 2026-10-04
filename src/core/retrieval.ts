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
  /** Position in the full-text ranking; absent when the chunk was not a lexical candidate. */
  lexicalRank?: number;
};

/** A chunk's text and the document it belongs to. */
export type StoredChunk = {
  chunkId: string;
  documentId: string;
  fileName: string;
  chunkIndex: number;
  content: string;
  /** Source pages of a PDF chunk (see ChunkRecord); undefined when unknown. */
  pageStart?: number;
  pageEnd?: number;
};

/** A candidate chunk ready to become LLM context, with the reason it was retrieved. */
export type RetrievedChunk = StoredChunk & {
  ranking: RetrievalRanking;
};
