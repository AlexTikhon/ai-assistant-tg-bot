import type { EmbeddingsProvider } from "../application/ports/embeddings-provider.js";
import { ENGLISH_STOP_WORDS } from "../core/lexical-query.js";

/** Concept name -> words that express it. Words of one concept share a single dimension. */
export type Lexicon = Record<string, string[]>;

export type LexiconEmbeddingOptions = {
  /** Hashed bag-of-words dimensions that give unknown words (identifiers, names) a weak signal. */
  hashBuckets?: number;
  /** Weight of the hashed block relative to the concept block (1). */
  hashWeight?: number;
};

const TOKEN = /[\p{L}\p{N}]+(?:[.'-][\p{L}\p{N}]+)*/gu;

/** Crude suffix stripping, applied to both the lexicon and the text so they meet in the middle. */
function stem(word: string) {
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

/** FNV-1a over UTF-16 code units: stable across platforms and runs. */
function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return value;
}

function normalized(vector: number[]) {
  const norm = Math.hypot(...vector);
  return norm === 0 ? vector : vector.map((value) => value / norm);
}

/**
 * A deterministic stand-in for an embeddings model, for offline evaluation.
 *
 * Real embedding models place paraphrases close together; a hash of the words cannot do that. This one
 * gets there with an explicit synonym lexicon: every concept is a dimension, and a text's vector says
 * how strongly it talks about each concept (sublinear in the count), plus a small hashed bag-of-words
 * block so that exact rare words still count a little. Vectors are L2-normalized, so cosine similarity
 * behaves like it does with real embeddings.
 *
 * It exists to exercise the whole retrieval pipeline reproducibly, free of charge and without network
 * access. It does NOT predict OpenAI embedding quality - run the live evaluation for that.
 */
export class LexiconEmbeddings implements EmbeddingsProvider {
  readonly model = "eval-lexicon-v1";
  readonly dimension: number;
  private readonly conceptsByStem = new Map<string, number[]>();
  private readonly conceptCount: number;
  private readonly hashBuckets: number;
  private readonly hashWeight: number;

  constructor(lexicon: Lexicon, options: LexiconEmbeddingOptions = {}) {
    this.hashBuckets = options.hashBuckets ?? 256;
    this.hashWeight = options.hashWeight ?? 0.6;

    const concepts = Object.entries(lexicon);
    this.conceptCount = concepts.length;
    this.dimension = this.conceptCount + this.hashBuckets;

    concepts.forEach(([, words], conceptIndex) => {
      for (const word of words) {
        const key = stem(word.toLowerCase());
        const indices = this.conceptsByStem.get(key) ?? [];
        if (!indices.includes(conceptIndex)) {
          indices.push(conceptIndex);
        }
        this.conceptsByStem.set(key, indices);
      }
    });
  }

  async embedDocuments(texts: string[]) {
    return texts.map((text) => this.embed(text));
  }

  async embedQuery(text: string) {
    return this.embed(text);
  }

  private embed(text: string): number[] {
    const concepts = new Array<number>(this.conceptCount).fill(0);
    const buckets = new Array<number>(this.hashBuckets).fill(0);

    for (const [token] of text.toLowerCase().matchAll(TOKEN)) {
      const key = stem(token);
      for (const concept of this.conceptsByStem.get(key) ?? []) {
        concepts[concept] += 1;
      }
      if (!ENGLISH_STOP_WORDS.has(token)) {
        const code = hash(key);
        buckets[code % this.hashBuckets] += code & 0x10000 ? 1 : -1;
      }
    }

    const sublinear = (value: number) => (value === 0 ? 0 : Math.sign(value) * (1 + Math.log(Math.abs(value))));
    const vector = [
      ...normalized(concepts.map(sublinear)),
      ...normalized(buckets.map(sublinear)).map((value) => value * this.hashWeight),
    ];

    // A text without any known word has no direction at all; give it a tiny fixed one so it stays a valid vector.
    return vector.every((value) => value === 0) ? [1e-6, ...vector.slice(1)] : normalized(vector);
  }
}
