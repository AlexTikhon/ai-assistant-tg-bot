import type { ChunkText, DocumentRecord } from "../../core/document.js";
import { trimChunkOverlap } from "../../core/chunk-overlap.js";
import { NotFoundError, ValidationError } from "../../shared/errors.js";
import { KeyedMutex } from "../../shared/keyed-mutex.js";
import { logger } from "../../shared/logger.js";
import { truncateText } from "../../shared/utils/text.js";
import { buildSummaryMessages } from "../prompts/summarize-document.prompt.js";
import type { InfoLog } from "../../shared/logger.js";
import type { ChatMessage, ChatModel } from "../ports/chat-model.js";
import type { DocumentRepository } from "../ports/document-repository.js";
import type { VectorStore } from "../ports/vector-store.js";

export type SummarizeDocumentResult = {
  document: DocumentRecord;
  summary: string;
};

export type SummaryLimits = {
  /** Documents up to this many characters are summarized in a single call. */
  directMaxChars: number;
  /** Size of the text groups summarized separately for longer documents. */
  groupMaxChars: number;
  /** Safety valve for the reduce step: stop re-summarizing after this many rounds. */
  maxReduceRounds: number;
  /** CHUNK_OVERLAP the documents were split with; repeated overlap is trimmed from the summary input (0 = none). */
  chunkOverlap: number;
};

type Dependencies = {
  documents: DocumentRepository;
  vectorStore: VectorStore;
  chatModel: ChatModel;
  options?: Partial<SummaryLimits>;
  log?: InfoLog;
};

const DEFAULT_LIMITS: SummaryLimits = { directMaxChars: 12_000, groupMaxChars: 8_000, maxReduceRounds: 4, chunkOverlap: 0 };
const SEPARATOR = "\n\n";

const log = logger.child({ operation: "summarizeDocument" });

/**
 * Summarizes a document and caches the result on the document record.
 *
 * Short documents are summarized in one call. Longer ones use map-reduce: consecutive chunks are
 * grouped, every group is summarized, and the partial summaries are summarized again until they fit.
 * The overlap the splitter repeats between neighbouring chunks is removed first, so no text is summarized twice.
 *
 * Requests for the same document run one at a time: a second request waits and then reuses the cached
 * summary instead of paying for the same LLM calls again.
 */
export class SummarizeDocumentUseCase {
  private readonly limits: SummaryLimits;
  private readonly documentLocks = new KeyedMutex();

  constructor(private readonly deps: Dependencies) {
    this.limits = { ...DEFAULT_LIMITS, ...deps.options };
  }

  execute(userId: string, documentId: string): Promise<SummarizeDocumentResult> {
    return this.documentLocks.run(`${userId}:${documentId}`, () => this.summarize(userId, documentId));
  }

  private async summarize(userId: string, documentId: string): Promise<SummarizeDocumentResult> {
    const { documents, vectorStore } = this.deps;

    const document = await documents.findById(userId, documentId);
    if (!document) {
      throw new NotFoundError();
    }

    if (document.summary) {
      return { document, summary: document.summary };
    }

    const chunks = await vectorStore.listByDocument(userId, documentId);
    if (chunks.length === 0) {
      throw new ValidationError("This document has no indexed text to summarize.");
    }

    const startedAt = Date.now();
    const calls = { generation: 0 }; // per request: summaries of different documents run concurrently
    const summary = await this.summarizeChunks(chunks, calls);
    // Only if the content is still the one that was summarized: a replacement during generation wins.
    await documents.updateSummary(userId, documentId, summary, document.documentVersion ?? 1);

    (this.deps.log ?? log).info(
      { userId, documentId, chunks: chunks.length, generationCalls: calls.generation, durationMs: Date.now() - startedAt },
      "Summary generated",
    );

    return { document: { ...document, summary }, summary };
  }

  /** One generation call, counted for the cost log. */
  private generate(calls: { generation: number }, messages: ChatMessage[]) {
    calls.generation += 1;
    return this.deps.chatModel.complete(messages);
  }

  private async summarizeChunks(chunks: ChunkText[], calls: { generation: number }) {
    const texts = trimChunkOverlap(chunks, this.limits.chunkOverlap).filter((text) => text.length > 0);

    if (totalLength(texts) <= this.limits.directMaxChars) {
      return this.generate(calls, buildSummaryMessages(texts.join(SEPARATOR), { kind: "direct" }));
    }

    let partials = await this.summarizeGroups(groupTexts(texts, this.limits.groupMaxChars), calls);

    for (
      let round = 1;
      totalLength(partials) > this.limits.directMaxChars && round <= this.limits.maxReduceRounds;
      round += 1
    ) {
      partials = await this.summarizeGroups(groupTexts(partials, this.limits.groupMaxChars), calls);
    }

    const combined = truncateText(partials.join(SEPARATOR), this.limits.directMaxChars);
    return this.generate(calls, buildSummaryMessages(combined, { kind: "combine" }));
  }

  /** Summarizes each group sequentially (deterministic order, gentle on provider rate limits). */
  private async summarizeGroups(groups: string[], calls: { generation: number }) {
    const summaries: string[] = [];
    for (const [index, group] of groups.entries()) {
      summaries.push(
        await this.generate(calls, buildSummaryMessages(group, { kind: "part", index, total: groups.length })),
      );
    }
    return summaries;
  }
}

function totalLength(texts: string[]) {
  return texts.reduce((sum, text) => sum + text.length, 0) + SEPARATOR.length * Math.max(0, texts.length - 1);
}

/** Greedily packs consecutive texts into groups of at most `maxChars` (a single oversized text gets its own group). */
export function groupTexts(texts: string[], maxChars: number) {
  const groups: string[] = [];
  let current: string[] = [];

  for (const text of texts) {
    if (current.length > 0 && totalLength([...current, text]) > maxChars) {
      groups.push(current.join(SEPARATOR));
      current = [];
    }
    current.push(text);
  }

  if (current.length > 0) {
    groups.push(current.join(SEPARATOR));
  }

  return groups;
}
