import type { Citation } from "../../core/document.js";
import { ValidationError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { buildAnswerMessages } from "../prompts/answer-question.prompt.js";
import { ensureQueryEmbedding } from "../validate-embeddings.js";
import type { ChatModel } from "../ports/chat-model.js";
import type { EmbeddingsProvider } from "../ports/embeddings-provider.js";
import type { VectorStore } from "../ports/vector-store.js";

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
  embeddings: EmbeddingsProvider;
  vectorStore: VectorStore;
  chatModel: ChatModel;
  options: { topK: number; minScore: number; logQuestions?: boolean };
};

const log = logger.child({ operation: "answerQuestion" });

/** Retrieval-augmented answering over the asking user's own documents. */
export class AnswerQuestionUseCase {
  constructor(private readonly deps: Dependencies) {}

  async execute(input: AnswerQuestionInput): Promise<AnswerQuestionResult> {
    const startedAt = Date.now();
    const { embeddings, vectorStore, chatModel, options } = this.deps;

    const question = input.question.trim();
    if (!question) {
      throw new ValidationError("Question is empty.");
    }
    if (question.length > MAX_QUESTION_CHARS) {
      throw new ValidationError(`The question is too long (max ${MAX_QUESTION_CHARS} characters).`);
    }

    const queryEmbedding = await embeddings.embedQuery(question);
    ensureQueryEmbedding(queryEmbedding);

    const chunks = await vectorStore.searchSimilar({
      userId: input.userId,
      documentId: input.documentId,
      embedding: queryEmbedding,
      embeddingModel: embeddings.model,
      topK: options.topK,
      minScore: options.minScore,
    });

    log.info(
      {
        userId: input.userId,
        questionLength: question.length,
        ...(options.logQuestions ? { question } : {}),
        retrieved: chunks.length,
        topScore: chunks[0]?.score,
        durationMs: Date.now() - startedAt,
      },
      "Question retrieval finished",
    );

    if (chunks.length === 0) {
      return { answer: NO_CONTEXT_ANSWER, sources: [] };
    }

    const answer = await chatModel.complete(buildAnswerMessages(question, chunks));

    return {
      answer,
      sources: chunks.map((chunk) => ({
        documentId: chunk.documentId,
        fileName: chunk.fileName,
        chunkIndex: chunk.chunkIndex,
        score: chunk.score,
      })),
    };
  }
}
