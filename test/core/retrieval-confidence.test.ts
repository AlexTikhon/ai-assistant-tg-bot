import { describe, expect, it } from "vitest";
import { assessRetrievalConfidence, validateConfidencePolicy } from "../../src/core/retrieval-confidence.js";
import type { ConfidencePolicy, RetrievalSignals } from "../../src/core/retrieval-confidence.js";

const policy: ConfidencePolicy = { minSemanticScore: 0.5, minTermCoverage: 0.6, requireKnownIdentifiers: true };

/** Signals of a question that found a few candidates but nothing convincing. */
const weak = (overrides: Partial<RetrievalSignals> = {}): RetrievalSignals => ({
  semanticCount: 3,
  lexicalCount: 3,
  candidateCount: 5,
  topSemanticScore: 0.3,
  semanticGap: 0.02,
  topLexicalScore: 3,
  topFusedScore: 0.0328,
  fusedGap: 0.0005,
  dualMethodCount: 2,
  bestDualRank: 1,
  exactTargets: 0,
  exactTargetsFound: 0,
  identifiers: 0,
  identifiersFound: 0,
  bestExactRank: null,
  bestTermCoverage: 0.2,
  ...overrides,
});

describe("assessRetrievalConfidence", () => {
  it("abstains when nothing was retrieved at all", () => {
    const result = assessRetrievalConfidence(weak({ candidateCount: 0, topSemanticScore: null, bestTermCoverage: 0 }), policy);

    expect(result).toMatchObject({ decision: "abstain", reason: "no-candidates" });
  });

  it("abstains on weak evidence: low similarity, low word overlap, no exact token", () => {
    expect(assessRetrievalConfidence(weak(), policy)).toMatchObject({ decision: "abstain", reason: "weak-evidence" });
  });

  it("answers on strong semantic evidence, and the threshold is inclusive", () => {
    expect(assessRetrievalConfidence(weak({ topSemanticScore: 0.5 }), policy)).toMatchObject({ decision: "answer", reason: "semantic" });
    expect(assessRetrievalConfidence(weak({ topSemanticScore: 0.499 }), policy).decision).toBe("abstain");
  });

  it("answers on semantic-only evidence without any lexical match", () => {
    const result = assessRetrievalConfidence(weak({ lexicalCount: 0, topLexicalScore: null, dualMethodCount: 0, bestDualRank: null, topSemanticScore: 0.7 }), policy);

    expect(result).toMatchObject({ decision: "answer", reason: "semantic" });
  });

  it("answers on a lexical-only exact token even though no vector matched", () => {
    const result = assessRetrievalConfidence(
      weak({ semanticCount: 0, topSemanticScore: null, semanticGap: null, dualMethodCount: 0, bestDualRank: null, exactTargets: 1, exactTargetsFound: 1, identifiers: 1, identifiersFound: 1, bestExactRank: 1 }),
      policy,
    );

    expect(result).toMatchObject({ decision: "answer", reason: "exact-token" });
  });

  it("answers when most of the question's words are in one candidate, and the threshold is inclusive", () => {
    expect(assessRetrievalConfidence(weak({ bestTermCoverage: 0.6 }), policy)).toMatchObject({ decision: "answer", reason: "term-coverage" });
    expect(assessRetrievalConfidence(weak({ bestTermCoverage: 0.59 }), policy).decision).toBe("abstain");
  });

  it("abstains when the question names an identifier that none of the candidates contains - even with strong similarity", () => {
    const result = assessRetrievalConfidence(weak({ topSemanticScore: 0.9, bestTermCoverage: 1, exactTargets: 1, identifiers: 1 }), policy);

    expect(result).toMatchObject({ decision: "abstain", reason: "identifier-not-found" });
  });

  it("does not let a missing quoted phrase veto: only identifiers, file names and versions do", () => {
    const result = assessRetrievalConfidence(weak({ topSemanticScore: 0.9, exactTargets: 1, identifiers: 0 }), policy);

    expect(result).toMatchObject({ decision: "answer", reason: "semantic" });
  });

  it("can be told to ignore missing identifiers", () => {
    const result = assessRetrievalConfidence(weak({ topSemanticScore: 0.9, exactTargets: 1, identifiers: 1 }), {
      ...policy,
      requireKnownIdentifiers: false,
    });

    expect(result).toMatchObject({ decision: "answer", reason: "semantic" });
  });

  it("lets one found identifier outweigh another that is missing", () => {
    const result = assessRetrievalConfidence(
      weak({ exactTargets: 2, exactTargetsFound: 1, identifiers: 2, identifiersFound: 1, bestExactRank: 2 }),
      policy,
    );

    expect(result).toMatchObject({ decision: "answer", reason: "exact-token" });
  });

  it("hands back the signals it judged", () => {
    const signals = weak({ topSemanticScore: 0.8 });

    expect(assessRetrievalConfidence(signals, policy).signals).toBe(signals);
  });

  it("is deterministic: the same signals always give the same decision", () => {
    const signals = weak({ topSemanticScore: 0.55 });

    expect(assessRetrievalConfidence(signals, policy)).toEqual(assessRetrievalConfidence({ ...signals }, policy));
  });
});

describe("validateConfidencePolicy", () => {
  it("accepts a sensible policy", () => {
    expect(() => validateConfidencePolicy(policy)).not.toThrow();
    expect(() => validateConfidencePolicy({ ...policy, minSemanticScore: -1, minTermCoverage: 1 })).not.toThrow();
  });

  it.each([
    [{ minSemanticScore: 1.5 }, /minSemanticScore/],
    [{ minSemanticScore: -1.1 }, /minSemanticScore/],
    [{ minSemanticScore: Number.NaN }, /minSemanticScore/],
    [{ minTermCoverage: -0.1 }, /minTermCoverage/],
    [{ minTermCoverage: 1.01 }, /minTermCoverage/],
    [{ minTermCoverage: Number.NaN }, /minTermCoverage/],
  ])("rejects %j", (override, message) => {
    expect(() => validateConfidencePolicy({ ...policy, ...override })).toThrow(message);
  });
});
