import { ENGLISH_STOP_WORDS } from "./lexical-query.js";
import type { RetrievedChunk } from "./retrieval.js";
import { analyzeQuery, matchesExactTarget } from "./technical-tokens.js";

/**
 * Numbers that describe how good the retrieved evidence for one question is. They are *inputs* to a
 * decision, not a decision: whether any of them is a useful measure of "the answer is in the documents"
 * is established by the offline evaluation (npm run eval:confidence), not assumed.
 */
export type RetrievalSignals = {
  semanticCount: number;
  lexicalCount: number;
  candidateCount: number;
  /** Best cosine similarity among the semantic candidates; null when there were none. Scale depends on the embedding model. */
  topSemanticScore: number | null;
  /** Cosine similarity of the best semantic candidate minus the second best; null with fewer than two. */
  semanticGap: number | null;
  /** Best full-text score (negated BM25, higher is better); null without lexical matches. Corpus dependent. */
  topLexicalScore: number | null;
  /** Fused (RRF) score of the best candidate, and its lead over the second; null when absent. */
  topFusedScore: number | null;
  fusedGap: number | null;
  /** Candidates that both the semantic and the lexical ranking found, and the fused rank of the best of them. */
  dualMethodCount: number;
  bestDualRank: number | null;
  /** Identifiers/file names/versions/quoted phrases in the question, how many of them occur in a candidate, and where the first such candidate ranks. */
  exactTargets: number;
  exactTargetsFound: number;
  /** The same for identifiers, file names and versions only (not quoted phrases). */
  identifiers: number;
  identifiersFound: number;
  bestExactRank: number | null;
  /** Largest share of the question's content words that a single candidate contains (0..1). */
  bestTermCoverage: number;
};

export type SignalInput = {
  question: string;
  /**
   * The fused candidates, best first (before de-duplication and caps), after they were loaded for the asking
   * user. Evidence is measured on these alone - never on raw per-method match lists - so a chunk of another
   * user, or one deleted since it was ranked, cannot influence the decision.
   */
  candidates: readonly RetrievedChunk[];
};

const WORD = /[\p{L}\p{N}]+/gu;

/** Distinct lower-case words of a text without stop words and single characters. */
function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const [word] of text.normalize("NFC").toLowerCase().matchAll(WORD)) {
    if (word.length >= 2 && !ENGLISH_STOP_WORDS.has(word)) {
      words.add(word);
    }
  }
  return words;
}

/** The best value and its lead over the second best; the lead is null with fewer than two values. */
function topTwo(values: number[]): { best: number | null; lead: number | null } {
  const sorted = [...values].sort((a, b) => b - a);
  return { best: sorted[0] ?? null, lead: sorted.length >= 2 ? sorted[0] - sorted[1] : null };
}

/** Pure and deterministic; reads only what retrieval already produced for this user. */
export function computeRetrievalSignals(input: SignalInput): RetrievalSignals {
  const { candidates } = input;
  const features = analyzeQuery(input.question);
  const queryWords = contentWords(input.question);

  const semanticScores = candidates.flatMap(({ ranking }) => (ranking.semanticScore === undefined ? [] : [ranking.semanticScore]));
  const lexicalScores = candidates.flatMap(({ ranking }) => (ranking.lexicalScore === undefined ? [] : [ranking.lexicalScore]));
  const semantic = topTwo(semanticScores);
  const fused = candidates.map(({ ranking }) => ranking.fusedScore);

  const firstDual = candidates.find(({ ranking }) => ranking.semanticRank !== undefined && ranking.lexicalRank !== undefined);

  const identifierTargets = new Set(features.technicalTokens.map((token) => token.text));
  const foundTargets = new Set<string>();
  let bestExactRank: number | null = null;
  let bestTermCoverage = 0;
  for (const chunk of candidates) {
    const hits = features.exactTargets.filter((target) => matchesExactTarget(chunk, target));
    hits.forEach((target) => foundTargets.add(target));
    if (hits.length > 0 && bestExactRank === null) {
      bestExactRank = chunk.ranking.fusedRank;
    }

    if (queryWords.size > 0) {
      const words = contentWords(chunk.content);
      const shared = [...queryWords].filter((word) => words.has(word)).length;
      bestTermCoverage = Math.max(bestTermCoverage, shared / queryWords.size);
    }
  }

  return {
    semanticCount: candidates.filter(({ ranking }) => ranking.semanticRank !== undefined).length,
    lexicalCount: candidates.filter(({ ranking }) => ranking.lexicalRank !== undefined).length,
    candidateCount: candidates.length,
    topSemanticScore: semantic.best,
    semanticGap: semantic.lead,
    topLexicalScore: topTwo(lexicalScores).best,
    topFusedScore: fused[0] ?? null,
    fusedGap: fused.length >= 2 ? fused[0] - fused[1] : null,
    dualMethodCount: candidates.filter(({ ranking }) => ranking.semanticRank !== undefined && ranking.lexicalRank !== undefined).length,
    bestDualRank: firstDual?.ranking.fusedRank ?? null,
    exactTargets: features.exactTargets.length,
    exactTargetsFound: foundTargets.size,
    identifiers: identifierTargets.size,
    identifiersFound: [...foundTargets].filter((target) => identifierTargets.has(target)).length,
    bestExactRank,
    bestTermCoverage,
  };
}

/**
 * The evidence rules, in the order they are applied. Chosen with `npm run eval:confidence` on the
 * calibration split of the evaluation dataset (see docs/evaluation.md) - not by intuition.
 */
export type ConfidencePolicy = {
  /** Best cosine similarity that counts as strong semantic evidence. Depends on the embedding model. */
  minSemanticScore: number;
  /** Share of the question's content words one candidate must contain to count as strong lexical evidence. */
  minTermCoverage: number;
  /** Abstain when the question names an identifier, file name or version that no candidate contains. */
  requireKnownIdentifiers: boolean;
};

/**
 * The policy the bot ships with. Chosen on the calibration split of eval/datasets/retrieval.jsonl with
 * `npm run eval:confidence` (docs/evaluation.md): the least aggressive policy that keeps recall >= 0.9 there.
 * The similarity threshold is specific to the embedding model; re-run the calibration if it changes.
 */
export const DEFAULT_CONFIDENCE_POLICY: ConfidencePolicy = { minSemanticScore: 0.5, minTermCoverage: 0.6, requireKnownIdentifiers: true };

/** No gate: anything that was retrieved counts as evidence. What a retriever without a configured policy uses. */
export const PASS_THROUGH_POLICY: ConfidencePolicy = { minSemanticScore: -1, minTermCoverage: 0, requireKnownIdentifiers: false };

/**
 * How the confidence gate is operated:
 * - off:     no gate; whatever was retrieved is used.
 * - shadow:  the decision is computed and logged, but the user gets the same answer as with the gate off.
 * - enforce: weak evidence is answered with a deterministic abstention, before any generation.
 */
export type ConfidenceMode = "off" | "shadow" | "enforce";

/** Why the evidence was judged sufficient. */
type AnswerReason = "exact-token" | "semantic" | "term-coverage";
/** Why it was not. */
export type AbstainReason = "no-candidates" | "identifier-not-found" | "weak-evidence";
export type ConfidenceReason = AnswerReason | AbstainReason;

export type ConfidenceAssessment =
  | { decision: "answer"; reason: AnswerReason; signals: RetrievalSignals }
  | { decision: "abstain"; reason: AbstainReason; signals: RetrievalSignals };

/** Throws a RangeError naming the offending field. */
export function validateConfidencePolicy(policy: ConfidencePolicy): void {
  if (!Number.isFinite(policy.minSemanticScore) || policy.minSemanticScore < -1 || policy.minSemanticScore > 1) {
    throw new RangeError("minSemanticScore must be a number between -1 and 1");
  }
  if (!Number.isFinite(policy.minTermCoverage) || policy.minTermCoverage < 0 || policy.minTermCoverage > 1) {
    throw new RangeError("minTermCoverage must be a number between 0 and 1");
  }
}

/**
 * Decides whether the retrieved evidence is worth sending to the model. The first matching rule wins:
 *
 * 1. nothing was retrieved                                            -> abstain
 * 2. an identifier/file/version in the question occurs nowhere        -> abstain (the documents cannot answer it)
 * 3. an exact target of the question occurs in a candidate            -> answer
 * 4. the best cosine similarity is high enough                        -> answer
 * 5. one candidate contains most of the question's content words      -> answer
 * 6. otherwise                                                        -> abstain
 *
 * Pure and deterministic. The reason is for logs and tests, not for users.
 */
export function assessRetrievalConfidence(signals: RetrievalSignals, policy: ConfidencePolicy): ConfidenceAssessment {
  if (signals.candidateCount === 0) {
    return { decision: "abstain", reason: "no-candidates", signals };
  }
  if (policy.requireKnownIdentifiers && signals.identifiers > 0 && signals.identifiersFound === 0) {
    return { decision: "abstain", reason: "identifier-not-found", signals };
  }
  if (signals.exactTargetsFound > 0) {
    return { decision: "answer", reason: "exact-token", signals };
  }
  if (signals.topSemanticScore !== null && signals.topSemanticScore >= policy.minSemanticScore) {
    return { decision: "answer", reason: "semantic", signals };
  }
  if (signals.bestTermCoverage >= policy.minTermCoverage) {
    return { decision: "answer", reason: "term-coverage", signals };
  }
  return { decision: "abstain", reason: "weak-evidence", signals };
}
