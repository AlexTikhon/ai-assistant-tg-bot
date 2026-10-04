import type { Citation } from "../../core/document.js";
import type { RetrievedChunk } from "../../core/retrieval.js";
import { ValidationError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import type { InfoLog } from "../../shared/logger.js";
import type { HybridRetriever, RetrievalTrace } from "../hybrid-retriever.js";
import { buildAnswerMessages } from "../prompts/answer-question.prompt.js";
import type { ChatModel } from "../ports/chat-model.js";

export const MAX_QUESTION_CHARS = 2000;
export const NO_CONTEXT_ANSWER = "I could not confirm the answer from the uploaded documents.";

export type AnswerQuestionInput = {
  userId: string;
  question: string;
  documentId?: string;
};

export type AnswerQuestionResult = {
  answer: string;
  sources: Citation[];
};

type Dependencies = {
  retriever: HybridRetriever;
  chatModel: ChatModel;
  options?: {
    /** Include the question text in logs (development only). */
    logQuestions?: boolean;
    /** Emit an extra structured entry that explains every retrieval (ids, ranks, counts - never text). */
    ragDebug?: boolean;
  };
  log?: InfoLog;
};

/** Retrieval-augmented answering over the asking user's own documents. */
export class AnswerQuestionUseCase {
  private readonly log: InfoLog;

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

    const { chunks, trace } = await retriever.retrieve({
      userId: input.userId,
      documentId: input.documentId,
      question,
    });

    let answer = NO_CONTEXT_ANSWER;
    let generationMs = 0;
    if (chunks.length > 0) {
      const generationStart = performance.now();
      answer = await chatModel.complete(buildAnswerMessages(question, chunks));
      generationMs = elapsedSince(generationStart);
    }

    this.logRequest(input.userId, question, trace, chunks, { generationMs, durationMs: elapsedSince(startedAt) });

    return {
      answer,
      sources: chunks.map((chunk, index) => ({
        documentId: chunk.documentId,
        fileName: chunk.fileName,
        chunkIndex: chunk.chunkIndex,
        rank: index + 1,
        score: chunk.ranking.fusedScore,
      })),
    };
  }

  private logRequest(
    userId: string,
    question: string,
    trace: RetrievalTrace,
    chunks: RetrievedChunk[],
    timing: { generationMs: number; durationMs: number },
  ) {
    const { options } = this.deps;

    this.log.info(
      {
        userId,
        questionLength: question.length,
        ...(options?.logQuestions ? { question } : {}),
        selected: chunks.length,
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
