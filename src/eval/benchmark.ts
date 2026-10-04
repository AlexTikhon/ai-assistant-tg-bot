import { selectContext } from "../core/context-selection.js";
import { boostExactMatches, reciprocalRankFusion } from "../core/rank-fusion.js";
import { assessRetrievalConfidence, computeRetrievalSignals, DEFAULT_CONFIDENCE_POLICY } from "../core/retrieval-confidence.js";
import { analyzeQuery } from "../core/technical-tokens.js";
import type { ChunkRecord, DocumentRecord } from "../core/document.js";
import type { RetrievedChunk } from "../core/retrieval.js";
import { openDatabase } from "../infrastructure/sqlite/database.js";
import { SqliteDocumentRepository } from "../infrastructure/sqlite/sqlite-document-repository.js";
import { LEXICAL_SELECT, SqliteVectorStore } from "../infrastructure/sqlite/sqlite-vector-store.js";

export type GeneratedChunk = {
  id: string;
  documentId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
};

export type GenerateOptions = {
  count: number;
  dimension: number;
  users: number;
  chunksPerDocument: number;
  seed: number;
};

/** Small, fast, seedable PRNG (mulberry32): the same seed gives the same numbers on every machine. */
function createRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = "ba be bi bo bu da de di do du fa fe fi fo fu ga ge gi go gu ka ke ki ko ku la le li lo lu ma me mi mo mu na ne ni no nu".split(" ");
const VOCABULARY_SIZE = 3000;
const WORDS_PER_CHUNK = 120;

/** The i-th word of a synthetic vocabulary; unique per i, pronounceable, one FTS token. */
export function vocabularyWord(index: number) {
  const base = SYLLABLES.length;
  return `${SYLLABLES[index % base]}${SYLLABLES[Math.floor(index / base) % base]}${SYLLABLES[Math.floor(index / (base * base)) % base]}`;
}

/** Zipf-like sampler: low ranks are very common, most words are rare - the shape of natural text. */
function createWordSampler(random: () => number) {
  const cumulative: number[] = [];
  let total = 0;
  for (let rank = 1; rank <= VOCABULARY_SIZE; rank += 1) {
    total += 1 / rank;
    cumulative.push(total);
  }
  return () => {
    const target = random() * total;
    let low = 0;
    let high = cumulative.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (cumulative[mid] < target) low = mid + 1;
      else high = mid;
    }
    return vocabularyWord(low);
  };
}

function randomUnitVector(random: () => number, dimension: number) {
  const vector = Array.from({ length: dimension }, () => random() * 2 - 1);
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

/**
 * Deterministic synthetic chunks: Zipf-distributed text and random unit vectors, spread round-robin over
 * `users`. Not meaningful as content - only as realistic *load* for the scan, the full-text index and ranking.
 */
export function generateChunks(options: GenerateOptions): GeneratedChunk[] {
  const random = createRandom(options.seed);
  const sampleWord = createWordSampler(random);

  return Array.from({ length: options.count }, (_, n) => {
    const user = n % options.users;
    const localIndex = Math.floor(n / options.users);
    return {
      id: `chunk-${n}`,
      userId: `user-${user}`,
      documentId: `doc-${user}-${Math.floor(localIndex / options.chunksPerDocument)}`,
      chunkIndex: localIndex % options.chunksPerDocument,
      content: Array.from({ length: WORDS_PER_CHUNK }, sampleWord).join(" "),
      embedding: randomUnitVector(random, options.dimension),
    };
  });
}

/** Nearest-rank percentile (p in 0..100) of a list of numbers. */
export function percentile(values: readonly number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export type StageResult = { name: string; medianMs: number; p95Ms: number };

export type BenchmarkResult = {
  chunks: number;
  /** Chunks owned by the queried user; the rest belong to other users. */
  userChunks: number;
  stages: StageResult[];
  /** EXPLAIN QUERY PLAN of the lexical search, when requested. */
  lexicalPlan?: string[];
};

export type BenchmarkOptions = {
  sizes: number[];
  dimension: number;
  users: number;
  /** Measured repetitions per stage (after `warmup` unmeasured ones). */
  runs: number;
  warmup: number;
  seed: number;
  explain?: boolean;
};

const MODEL = "bench-model";
const QUERIES = 8;

async function timeStage(name: string, options: BenchmarkOptions, task: (iteration: number) => Promise<unknown> | unknown) {
  for (let i = 0; i < options.warmup; i += 1) await task(i);

  const timings: number[] = [];
  for (let i = 0; i < options.runs; i += 1) {
    const start = performance.now();
    await task(i);
    timings.push(performance.now() - start);
  }
  return { name, medianMs: percentile(timings, 50), p95Ms: percentile(timings, 95) };
}

/**
 * Measures the stages of retrieval on generated data of growing size. A benchmark, not a test: it
 * reports numbers and never fails because a machine is slow. Every stage queries one user's chunks
 * while the other users' chunks sit in the same tables, as in a shared deployment.
 */
export async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  for (const size of options.sizes) {
    const chunks = generateChunks({
      count: size,
      dimension: options.dimension,
      users: options.users,
      chunksPerDocument: 25,
      seed: options.seed,
    });
    const db = openDatabase(":memory:", { legacyEmbeddingModel: MODEL });
    try {
      const documents = new SqliteDocumentRepository(db);
      const store = new SqliteVectorStore(db);
      await load(documents, chunks);

      const userId = "user-0";
      const random = createRandom(options.seed + 1);
      const queryVectors = Array.from({ length: QUERIES }, () => randomUnitVector(random, options.dimension));
      const userChunks = chunks.filter((chunk) => chunk.userId === userId);
      const rareQueries = Array.from({ length: QUERIES }, (_, i) => {
        // Three words from the middle of one of the user's chunks: found in a handful of chunks, ranked by BM25.
        const words = userChunks[(i * 7) % userChunks.length].content.split(" ");
        return words.slice(40 + i, 43 + i).join(" ");
      });
      const commonQuery = [0, 1, 2].map(vocabularyWord).join(" ");

      const semanticLimit = 20;
      const semanticOf = (i: number) =>
        store.searchSimilar({ userId, embedding: queryVectors[i % QUERIES], embeddingModel: MODEL, limit: semanticLimit, minScore: -1 });
      const lexicalOf = (query: string) => store.searchLexical({ userId, query, limit: 20 });

      const semantic = await semanticOf(0);
      const lexical = await lexicalOf(commonQuery);
      const fused = reciprocalRankFusion(semantic, lexical).slice(0, 15);
      // The loaded candidate pool and a question with an identifier in it, as the exact-token and confidence code see them.
      const loadCandidates = async () => {
        const stored = await store.getChunks(userId, fused.map((match) => match.chunkId));
        const byId = new Map(stored.map((chunk) => [chunk.chunkId, chunk]));
        return fused.flatMap(({ chunkId, documentId, chunkIndex, ...ranking }): RetrievedChunk[] => {
          const chunk = byId.get(chunkId);
          return chunk ? [{ ...chunk, ranking }] : [];
        });
      };
      const pool = await loadCandidates();
      const identifierQuestion = `${rareQueries[0]} what does ERR_${vocabularyWord(7)}_42 mean in v2.14.1?`;

      const stages = [
        await timeStage("semantic scan", options, (i) => semanticOf(i)),
        await timeStage("FTS (rare terms)", options, (i) => lexicalOf(rareQueries[i % QUERIES])),
        await timeStage("FTS (common terms)", options, () => lexicalOf(commonQuery)),
        await timeStage("RRF fusion", options, () => reciprocalRankFusion(semantic, lexical)),
        await timeStage("context selection", options, async () => {
          const stored = await store.getChunks(userId, fused.map((match) => match.chunkId));
          const byId = new Map(stored.map((chunk) => [chunk.chunkId, chunk]));
          const candidates = fused.flatMap(({ chunkId, documentId, chunkIndex, ...ranking }): RetrievedChunk[] => {
            const chunk = byId.get(chunkId);
            return chunk ? [{ ...chunk, ranking }] : [];
          });
          return selectContext(candidates, { maxChunks: 5, maxChars: 6000, maxPerDocument: 3 });
        }),
        // The code added by the exact-token bonus and the answerability gate: pure CPU on the candidate pool.
        await timeStage("exact-token bonus", options, () =>
          boostExactMatches(pool, analyzeQuery(identifierQuestion).exactTargets, 1 / 61),
        ),
        await timeStage("evidence signals + gate", options, () =>
          assessRetrievalConfidence(
            computeRetrievalSignals({ question: identifierQuestion, candidates: pool }),
            DEFAULT_CONFIDENCE_POLICY,
          ),
        ),
      ];

      results.push({
        chunks: size,
        userChunks: userChunks.length,
        stages,
        lexicalPlan: options.explain
          ? (
              db
                .prepare(`EXPLAIN QUERY PLAN ${LEXICAL_SELECT} ORDER BY bm25(chunk_fts) LIMIT @limit`)
                .all({ match: `"${vocabularyWord(0)}"`, userId, limit: 20 }) as Array<{ detail: string }>
            ).map((step) => step.detail)
          : undefined,
      });
    } finally {
      db.close();
    }
  }

  return results;
}

async function load(documents: SqliteDocumentRepository, chunks: GeneratedChunk[]) {
  const byDocument = new Map<string, GeneratedChunk[]>();
  for (const chunk of chunks) {
    byDocument.set(chunk.documentId, [...(byDocument.get(chunk.documentId) ?? []), chunk]);
  }

  for (const [documentId, items] of byDocument) {
    const document: DocumentRecord = {
      id: documentId,
      userId: items[0].userId,
      fileName: `${documentId}.txt`,
      storedName: `${documentId}.txt`,
      mimeType: "text/plain",
      fileSize: 1,
      textLength: items.reduce((sum, item) => sum + item.content.length, 0),
      summary: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const records: ChunkRecord[] = items.map((item) => ({
      ...item,
      embeddingModel: MODEL,
      createdAt: document.createdAt,
    }));
    await documents.saveWithChunks(document, records);
  }
}

const round = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));

/** A compact table: one row per stage, one "median / p95" column per size. */
export function formatBenchmark(results: readonly BenchmarkResult[], context: { dimension: number; users: number; runs: number }) {
  const headers = results.map((result) => `${result.chunks} chunks`);
  const width = Math.max(...headers.map((header) => header.length), 14);
  const stageNames = results[0].stages.map((stage) => stage.name);
  const nameWidth = Math.max(...stageNames.map((name) => name.length));

  const lines = [
    `Retrieval benchmark: ${context.dimension}-dimensional vectors, ${context.users} user(s), ${context.runs} runs per stage; times in ms, median / p95`,
    `The queried user owns ${results.map((result) => result.userChunks).join(" / ")} of the chunks; the others share the same tables.`,
    "",
    `${"stage".padEnd(nameWidth)}  ${headers.map((header) => header.padStart(width)).join("  ")}`,
    ...stageNames.map((name, index) => {
      const cells = results.map((result) => {
        const stage = result.stages[index];
        return `${round(stage.medianMs)} / ${round(stage.p95Ms)}`.padStart(width);
      });
      return `${name.padEnd(nameWidth)}  ${cells.join("  ")}`;
    }),
  ];

  const plan = results.find((result) => result.lexicalPlan)?.lexicalPlan;
  if (plan) {
    lines.push("", "Lexical query plan (EXPLAIN QUERY PLAN):", ...plan.map((step) => `  ${step}`));
  }
  return lines.join("\n");
}
