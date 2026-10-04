import { describe, expect, it } from "vitest";
import type { RetrievalRanking, RetrievedChunk } from "../../src/core/retrieval.js";
import { computeRetrievalSignals } from "../../src/core/retrieval-confidence.js";

function candidate(chunkId: string, content: string, ranking: RetrievalRanking, fileName = "notes.md"): RetrievedChunk {
  return { chunkId, documentId: "doc", fileName, chunkIndex: Number(chunkId.slice(1)), content, ranking };
}

describe("computeRetrievalSignals", () => {
  it("reports empty evidence as nulls and zeros, never NaN", () => {
    const signals = computeRetrievalSignals({ question: "anything at all?", candidates: [] });

    expect(signals).toEqual({
      semanticCount: 0,
      lexicalCount: 0,
      candidateCount: 0,
      topSemanticScore: null,
      semanticGap: null,
      topLexicalScore: null,
      topFusedScore: null,
      fusedGap: null,
      dualMethodCount: 0,
      bestDualRank: null,
      exactTargets: 0,
      exactTargetsFound: 0,
      identifiers: 0,
      identifiersFound: 0,
      bestExactRank: null,
      bestTermCoverage: 0,
    });
  });

  it("describes semantic-only evidence: top score and the gap to the runner-up", () => {
    const signals = computeRetrievalSignals({
      question: "How do I get my money back?",
      candidates: [
        candidate("c1", "Refunds are issued within 14 days", { fusedRank: 1, fusedScore: 1 / 61, semanticRank: 1, semanticScore: 0.7 }),
        candidate("c2", "Invoices are payable within 30 days", { fusedRank: 2, fusedScore: 1 / 62, semanticRank: 2, semanticScore: 0.55 }),
      ],
    });

    expect(signals.topSemanticScore).toBe(0.7);
    expect(signals.semanticGap).toBeCloseTo(0.15);
    expect(signals.semanticCount).toBe(2);
    expect(signals.lexicalCount).toBe(0);
    expect(signals.dualMethodCount).toBe(0);
    expect(signals.topFusedScore).toBeCloseTo(1 / 61);
    expect(signals.fusedGap).toBeCloseTo(1 / 61 - 1 / 62);
  });

  it("takes the best semantic score whatever the fused order, and has no gap with a single semantic candidate", () => {
    const ranked = computeRetrievalSignals({
      question: "q",
      candidates: [
        candidate("c1", "lexical first", { fusedRank: 1, fusedScore: 0.03, lexicalRank: 1, semanticRank: 2, semanticScore: 0.4 }),
        candidate("c2", "semantic first", { fusedRank: 2, fusedScore: 0.02, semanticRank: 1, semanticScore: 0.6 }),
      ],
    });
    const single = computeRetrievalSignals({
      question: "q",
      candidates: [candidate("c1", "only", { fusedRank: 1, fusedScore: 0.02, semanticRank: 1, semanticScore: 0.4 })],
    });

    expect(ranked.topSemanticScore).toBe(0.6);
    expect(ranked.semanticGap).toBeCloseTo(0.2);
    expect(single.topSemanticScore).toBe(0.4);
    expect(single.semanticGap).toBeNull();
  });

  it("finds an exact technical token that only the lexical ranking knows about", () => {
    const signals = computeRetrievalSignals({
      question: "What is error code E-4012?",
      candidates: [
        candidate("c9", "Some unrelated text about codes", { fusedRank: 1, fusedScore: 1 / 61, semanticRank: 1, semanticScore: 0.31 }),
        candidate("c1", "E-4012 means the battery is low.", { fusedRank: 2, fusedScore: 1 / 61, lexicalRank: 1, lexicalScore: 6.2 }),
      ],
    });

    expect(signals.exactTargets).toBe(1);
    expect(signals.exactTargetsFound).toBe(1);
    expect(signals.identifiers).toBe(1);
    expect(signals.identifiersFound).toBe(1);
    expect(signals.bestExactRank).toBe(2);
    expect(signals.topLexicalScore).toBe(6.2);
    expect(signals.lexicalCount).toBe(1);
    expect(signals.dualMethodCount).toBe(0);
  });

  it("counts a named file as found when a candidate belongs to that document", () => {
    const signals = computeRetrievalSignals({
      question: "What does notes.md say about batteries?",
      candidates: [candidate("c1", "Batteries last a year.", { fusedRank: 1, fusedScore: 1 / 61, lexicalRank: 1 })],
    });

    expect(signals.exactTargets).toBe(1);
    expect(signals.exactTargetsFound).toBe(1);
    expect(signals.bestExactRank).toBe(1);
  });

  it("does not count an exact target that no candidate contains", () => {
    const signals = computeRetrievalSignals({
      question: "What is error code E-9999?",
      candidates: [candidate("c1", "E-4012 means the battery is low.", { fusedRank: 1, fusedScore: 1 / 61, lexicalRank: 1 })],
    });

    expect(signals.exactTargets).toBe(1);
    expect(signals.exactTargetsFound).toBe(0);
    expect(signals.identifiers).toBe(1);
    expect(signals.identifiersFound).toBe(0);
    expect(signals.bestExactRank).toBeNull();
  });

  it("counts a quoted phrase as an exact target but not as an identifier", () => {
    const signals = computeRetrievalSignals({
      question: 'Where does it say "battery is low"?',
      candidates: [candidate("c1", "E-4012 means the battery is low.", { fusedRank: 1, fusedScore: 1 / 61, lexicalRank: 1 })],
    });

    expect(signals).toMatchObject({ exactTargets: 1, exactTargetsFound: 1, identifiers: 0, identifiersFound: 0 });
  });

  it("recognises chunks found by both methods and remembers where the first one ranks", () => {
    const signals = computeRetrievalSignals({
      question: "How do refunds work?",
      candidates: [
        candidate("c2", "Refunds are issued within 14 days", { fusedRank: 1, fusedScore: 1 / 62 + 1 / 61, semanticRank: 2, semanticScore: 0.4, lexicalRank: 1, lexicalScore: 3 }),
        candidate("c1", "The money goes back", { fusedRank: 2, fusedScore: 1 / 61, semanticRank: 1, semanticScore: 0.5 }),
        candidate("c3", "Policies", { fusedRank: 3, fusedScore: 1 / 62, lexicalRank: 2, lexicalScore: 2 }),
      ],
    });

    expect(signals.dualMethodCount).toBe(1);
    expect(signals.bestDualRank).toBe(1);
    expect(signals.semanticCount).toBe(2);
    expect(signals.lexicalCount).toBe(2);
    expect(signals.topLexicalScore).toBe(3);
  });

  it("measures how many of the question's content words the best candidate contains", () => {
    const signals = computeRetrievalSignals({
      question: "What is the capital of Australia?",
      candidates: [
        candidate("c1", "Capital expenditure above 1,000 euros must be approved.", { fusedRank: 1, fusedScore: 1 / 61, lexicalRank: 1 }),
        candidate("c2", "Australia is a country and its capital is a city.", { fusedRank: 2, fusedScore: 1 / 62, lexicalRank: 2 }),
      ],
    });

    // content words: capital, australia. c1 has one of two, c2 has both.
    expect(signals.bestTermCoverage).toBe(1);
  });

  it("ignores stop words when measuring coverage", () => {
    const signals = computeRetrievalSignals({
      question: "What is the of and a",
      candidates: [candidate("c1", "nothing", { fusedRank: 1, fusedScore: 0.1 })],
    });

    expect(signals.bestTermCoverage).toBe(0);
  });
});
