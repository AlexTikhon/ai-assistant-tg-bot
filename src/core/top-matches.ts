import type { ChunkMatch } from "./retrieval.js";

export function compareMatches(a: ChunkMatch, b: ChunkMatch) {
  return b.score - a.score || a.documentId.localeCompare(b.documentId) || a.chunkIndex - b.chunkIndex;
}

/** Worst match at the root; memory is O(K), regardless of how many vectors qualify. */
export class TopMatches {
  private readonly heap: ChunkMatch[] = [];

  constructor(private readonly limit: number) {}

  add(match: ChunkMatch) {
    if (this.limit <= 0) return;
    if (this.heap.length < this.limit) {
      this.heap.push(match);
      let child = this.heap.length - 1;
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (compareMatches(this.heap[child], this.heap[parent]) <= 0) break;
        [this.heap[child], this.heap[parent]] = [this.heap[parent], this.heap[child]];
        child = parent;
      }
      return;
    }
    if (compareMatches(match, this.heap[0]) >= 0) return;
    this.heap[0] = match;
    let parent = 0;
    for (;;) {
      const left = parent * 2 + 1;
      if (left >= this.heap.length) break;
      const right = left + 1;
      const child = right < this.heap.length && compareMatches(this.heap[right], this.heap[left]) > 0 ? right : left;
      if (compareMatches(this.heap[child], this.heap[parent]) <= 0) break;
      [this.heap[child], this.heap[parent]] = [this.heap[parent], this.heap[child]];
      parent = child;
    }
  }

  sorted() { return [...this.heap].sort(compareMatches); }
}
