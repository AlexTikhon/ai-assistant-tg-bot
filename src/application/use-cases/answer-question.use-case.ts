import { groundCitations } from "../../core/citations.js";
import type { Citation } from "../../core/document.js";
import type { RetrievedChunk } from "../../core/retrieval.js";
import type { AbstainReason, ConfidenceAssessment, RetrievalSignals } from "../../core/retrieval-confidence.js";
import { NotFoundError, ValidationError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { currentRequestId } from "../../shared/request-context.js";
import type { InfoLog, WarnLog } from "../../shared/logger.js";
import type { HybridRetriever, RetrievalResult, RetrievalTrace } from "../hybrid-retriever.js";
import type { AnswerOutcomes, ConfidenceOutcome } from "../ports/answer-outcomes.js";
import { buildAnswerMessages } from "../prompts/answer-question.prompt.js";
import type { ChatModel } from "../ports/chat-model.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import { operationSignal, operationStep } from "../../shared/operation.js";

export const MAX_QUESTION_CHARS = 2000;

export type AnswerQuestionInput = {
  userId: string;
  question: string;
  /** Answer from this one document only. It must be the user's own: any other id, including a nonexistent one, is "not found". */
  documentId?: string;
};

export type AnswerQuestionResult =
  | {
      kind: "answered";
      /** The model's answer with references to non-existent sources removed. */
      answer: string;
      sources: Citation[];
      /** Result of the deterministic [n] check: which sources the answer cites, and which invalid references were removed. */
      citations: { cited: number[]; removed: number[] };
    }
  | {
      /**
       * The user's indexed documents do not hold enough evidence for the question. Decided before the chat model:
       * no model was called, nothing was generated. It does not claim that the answer does not exist anywhere.
       */
      kind: "insufficient-evidence";
      /** For logs and tests; the user is told only that not enough information was found. */
      reason: AbstainReason;
    };

type Dependencies = {
  retriever: HybridRetriever;
  chatModel: ChatModel;
  /** Lets a document-scoped question about a document the user does not have fail as "not found" (retrieval itself is always owner-scoped too). */
  documents?: Pick<DocumentRepository, "findById">;
  options?: {
    /** Include the question text in logs (development only). */
    logQuestions?: boolean;
    /** Emit an extra structured entry that explains every retrieval (ids, ranks, counts - never text). */
    ragDebug?: boolean;
  };
  /** Where the confidence outcome of each answer is remembered (by request id) for later feedback. */
  outcomes?: AnswerOutcomes;
  log?: InfoLog & WarnLog;
};

/** Retrieval-augmented answering over the asking user's own documents. */
export class AnswerQuestionUseCase {
  private readonly log: InfoLog & WarnLog;

  constructor(private readonly deps: Dependencies) {
    this.log = deps.log ?? logger.child({ operation: "answerQuestion" });
  }

  async execute(input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
    const startedAt = performance.now();
    const { retriever, chatModel } = this.deps;

    const question = input.question.trim();
    if (!question) {
      throw new ValidationError("Question is empty.");
    }
    if (question.length > MAX_QUESTION_CHARS) {
      throw new ValidationError(`The question is too long (max ${MAX_QUESTION_CHARS} characters).`);
    }

    if (input.documentId !== undefined && this.deps.documents && !(await this.deps.documents.findById(input.userId, input.documentId))) {
      throw new NotFoundError();
    }

    const retrieval = await retriever.retrieve({
      userId: input.userId,
      documentId: input.documentId,
      question,
    });
    const { chunks, confidence, trace } = retrieval;
    this.observeConfidence(input.userId, retrieval, elapsedSince(startedAt));

    // Weak evidence is not sent to the model in the hope that the prompt makes it refuse: the decision is made here,
    // deterministically, before any paid generation.
    if (confidence.decision === "abstain" || chunks.length === 0) {
      const reason: AbstainReason = confidence.decision === "abstain" ? confidence.reason : "no-candidates";
      this.logAbstention(input.userId, question, reason, confidence.signals, trace, elapsedSince(startedAt));
      return { kind: "insufficient-evidence", reason };
    }

    const generationStart = performance.now();
    const generated = await operationStep(() => chatModel.complete(buildAnswerMessages(question, chunks), { signal: operationSignal() }));
    const generationMs = elapsedSince(generationStart);

    // Only checks that [n] points at one of the excerpts the model was shown - not that it is right.
    const grounded = groundCitations(generated, chunks.length);
    if (grounded.unknown.length > 0) {
      this.log.warn(
        { userId: input.userId, removedReferences: grounded.unknown, sources: chunks.length },
        "The answer cited sources that were not in the context; those references were removed",
      );
    }

    this.logRequest(input.userId, question, trace, chunks, confidence, { generationMs, durationMs: elapsedSince(startedAt) });

    return {
      kind: "answered",
      answer: grounded.text,
      sources: chunks.map((chunk, index) => ({
        documentId: chunk.documentId,
        fileName: chunk.fileName,
        chunkIndex: chunk.chunkIndex,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        pageLabelStart: chunk.pageLabelStart,
        pageLabelEnd: chunk.pageLabelEnd,
        sectionPath: chunk.sectionPath,
        rank: index + 1,
        score: chunk.ranking.fusedScore,
      })),
      citations: { cited: grounded.cited, removed: grounded.unknown },
    };
  }

  /**
   * Shadow mode: logs what the gate would have decided - and remembers the outcome for feedback - while the
   * answer proceeds exactly as without a gate. Labels, numbers and ids only: never the question (not even with
   * LOG_QUESTIONS), a document, the context or a vector, so the log can be kept and shared for calibration.
   */
  private observeConfidence(userId: string, retrieval: RetrievalResult, durationMs: number) {
    const { confidence, shadow } = retrieval;
    const decided = shadow?.assessment ?? confidence;
    const requestId = currentRequestId();

    if (shadow) {
      const { signals } = shadow.assessment;
      this.log.info(
        {
          userId,
          mode: "shadow",
          decision: shadow.assessment.decision,
          reason: shadow.assessment.reason,
          wouldAbstain: shadow.assessment.decision === "abstain",
          answered: confidence.decision === "answer" && retrieval.chunks.length > 0,
          semanticScore: signals.topSemanticScore,
          semanticGap: signals.semanticGap,
          threshold: shadow.policy.minSemanticScore,
          termCoverage: signals.bestTermCoverage,
          termCoverageThreshold: shadow.policy.minTermCoverage,
          exactTargets: signals.exactTargets,
          exactTargetsFound: signals.exactTargetsFound,
          identifiers: signals.identifiers,
          identifiersFound: signals.identifiersFound,
          candidateCount: signals.candidateCount,
          semanticCount: signals.semanticCount,
          lexicalCount: signals.lexicalCount,
          durationMs,
        },
        "Confidence gate shadow decision",
      );
    }

    if (requestId && this.deps.outcomes) {
      const outcome: ConfidenceOutcome = {
        mode: shadow ? "shadow" : this.deps.retriever.mode,
        decision: confidence.decision,
        reason: confidence.reason,
        ...(shadow ? { shadowDecision: decided.decision, shadowReason: decided.reason } : {}),
        topSemanticScore: decided.signals.topSemanticScore,
      };
      this.deps.outcomes.record(requestId, outcome);
    }
  }

  /** Numbers and ids only - never the question (unless LOG_QUESTIONS) and never document text. */
  private logAbstention(
    userId: string,
    question: string,
    reason: AbstainReason,
    signals: RetrievalSignals,
    trace: RetrievalTrace,
    durationMs: number,
  ) {
    this.log.info(
      {
        userId,
        questionLength: question.length,
        ...(this.deps.options?.logQuestions ? { question } : {}),
        reason,
        selected: 0,
        // Provider calls this question cost: the query embedding only - the chat model was never asked.
        calls: { embedding: 1, chat: 0 },
        signals,
        timings: trace.timings,
        durationMs,
      },
      "Question not answered: insufficient evidence",
    );
  }

  private logRequest(
    userId: string,
    question: string,
    trace: RetrievalTrace,
    chunks: RetrievedChunk[],
    confidence: ConfidenceAssessment,
    timing: { generationMs: number; durationMs: number },
  ) {
    const { options } = this.deps;

    this.log.info(
      {
        userId,
        questionLength: question.length,
        ...(options?.logQuestions ? { question } : {}),
        selected: chunks.length,
        calls: { embedding: 1, chat: 1 },
        timings: { ...trace.timings, generationMs: timing.generationMs },
        durationMs: timing.durationMs,
      },
      "Question answered",
    );

    if (options?.ragDebug) {
      this.log.info(
        {
          userId,
          counts: trace.counts,
          confidence: { decision: confidence.decision, reason: confidence.reason, signals: confidence.signals },
          contextChars: trace.contextChars,
          selected: chunks.map(({ chunkId, documentId, chunkIndex, ranking }) => ({
            chunkId,
            documentId,
            chunkIndex,
            ...ranking,
          })),
          skipped: trace.skipped,
        },
        "RAG retrieval debug",
      );
    }
  }
}

function elapsedSince(start: number) {
  return Math.round((performance.now() - start) * 10) / 10;
}
