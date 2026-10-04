import { buildDocumentText } from "../core/pages.js";
import { splitText } from "../core/text-splitter.js";
import type { EvalCase } from "./dataset.js";
import type { ChunkingSettings, CorpusDocument } from "./harness.js";

export type LiveRunPlan = {
  documents: number;
  /** Distinct chunk texts that will be embedded (the eval cache never pays twice for identical text). */
  chunkTexts: number;
  /** Distinct questions that will be embedded. */
  questions: number;
  embeddingInputs: number;
  /** OpenAI embedding requests: one per document that has text not seen before, plus one per question. */
  requests: { documents: number; questions: number; total: number };
  /** Very rough (4 characters per token) - for orientation, not for billing. */
  approxTokens: number;
};

/**
 * What `--live` would send to OpenAI, computed offline from the corpus and the questions, before anything is
 * sent. Mirrors how the evaluation indexes (one embedding call per document, identical texts cached) and
 * asks questions (one call per distinct question). The evaluation never calls a chat model.
 */
export function planLiveRun(input: {
  corpus: readonly CorpusDocument[];
  cases: readonly Pick<EvalCase, "question">[];
  chunking: ChunkingSettings;
}): LiveRunPlan {
  const seen = new Set<string>();
  let documentRequests = 0;
  let characters = 0;

  for (const document of input.corpus) {
    const { text } = buildDocumentText({ text: document.content });
    const texts = splitText(text, input.chunking).map((chunk) => chunk.content);
    const fresh = [...new Set(texts)].filter((chunk) => !seen.has(chunk));
    if (fresh.length > 0) {
      documentRequests += 1;
    }
    for (const chunk of fresh) {
      seen.add(chunk);
      characters += chunk.length;
    }
  }

  const questions = new Set(input.cases.map((item) => item.question));
  for (const question of questions) {
    characters += question.length;
  }

  return {
    documents: input.corpus.length,
    chunkTexts: seen.size,
    questions: questions.size,
    embeddingInputs: seen.size + questions.size,
    requests: { documents: documentRequests, questions: questions.size, total: documentRequests + questions.size },
    approxTokens: Math.ceil(characters / 4),
  };
}

export function formatLivePlan(plan: LiveRunPlan, model: string) {
  return [
    "WARNING: a live evaluation calls the OpenAI embeddings API and costs real money.",
    `Model: ${model}`,
    `Will embed ${plan.embeddingInputs} texts (${plan.chunkTexts} distinct chunks + ${plan.questions} distinct questions) in ${plan.requests.total} API requests`,
    `  (${plan.requests.documents} for the documents, ${plan.requests.questions} for the questions), about ${plan.approxTokens} tokens (rough estimate).`,
    "No chat model is called. The index is built in memory; no stored document is read or changed.",
  ].join("\n");
}
