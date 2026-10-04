import { beforeEach, describe, expect, it } from "vitest";
import { HybridRetriever } from "../../src/application/hybrid-retriever.js";
import { AnswerQuestionUseCase } from "../../src/application/use-cases/answer-question.use-case.js";
import { formatAnswer } from "../../src/telegram/ui/format.js";
import { createTestStores, FakeChatModel, KeywordEmbeddings, makeChunk, makeDocument } from "../support/fakes.js";

let stores: ReturnType<typeof createTestStores>;
let embeddings: KeywordEmbeddings;

const retrievalOptions = { topK: 4, minScore: 0.2, semanticLimit: 10, lexicalLimit: 10, contextMaxChars: 10_000 };

type Entry = { fields: Record<string, unknown>; message: string };

function createUseCase(chatModel: FakeChatModel) {
  const info: Entry[] = [];
  const warn: Entry[] = [];
  const useCase = new AnswerQuestionUseCase({
    retriever: new HybridRetriever({ embeddings, vectorStore: stores.vectorStore, options: retrievalOptions }),
    chatModel,
    log: {
      info: (fields, message) => void info.push({ fields, message }),
      warn: (fields, message) => void warn.push({ fields, message }),
    },
  });
  return { useCase, warn, info };
}

async function index(
  documentId: string,
  fileName: string,
  chunks: Array<{ content: string; pageStart?: number; pageEnd?: number }>,
) {
  await stores.documents.saveWithChunks(
    makeDocument({ id: documentId, userId: "user-1", fileName }),
    await Promise.all(
      chunks.map(async (chunk, chunkIndex) =>
        makeChunk({
          documentId,
          userId: "user-1",
          chunkIndex,
          embedding: await embeddings.embedQuery(chunk.content),
          ...chunk,
        }),
      ),
    ),
  );
}

beforeEach(() => {
  stores = createTestStores();
  embeddings = new KeywordEmbeddings();
});

describe("page provenance reaches the answer", () => {
  it("returns pages for PDF chunks, shows them in the prompt and in the Telegram source list", async () => {
    await index("pdf", "manual.pdf", [{ content: "the cat feeder resets itself", pageStart: 8, pageEnd: 9 }]);
    await index("md", "notes.md", [{ content: "the cat eats at noon" }]);
    const chat = new FakeChatModel("It resets [1], and eats at noon [2].");
    const { useCase } = createUseCase(chat);

    const result = await useCase.execute({ userId: "user-1", question: "cat feeder" });

    expect(result.sources.map(({ fileName, pageStart, pageEnd }) => ({ fileName, pageStart, pageEnd }))).toEqual(
      expect.arrayContaining([
        { fileName: "manual.pdf", pageStart: 8, pageEnd: 9 },
        { fileName: "notes.md", pageStart: undefined, pageEnd: undefined },
      ]),
    );
    const prompt = chat.calls[0].map((message) => message.content).join("\n");
    expect(prompt).toContain("manual.pdf, pp. 8–9");
    expect(prompt).toContain("notes.md, chunk 1");
    const text = formatAnswer(result);
    expect(text).toContain("manual.pdf · pp. 8–9");
    expect(text).toContain("notes.md · chunk 1");
  });
});

describe("citation numbering stays consistent through deduplication and diversification", () => {
  it("numbers the prompt excerpts and the displayed sources identically, with no gaps, when candidates are skipped", async () => {
    // The same text twice (a re-uploaded file) plus overlapping neighbours: several candidates get dropped.
    const duplicated = "the cat sleeps on the warm sofa all afternoon long";
    await index("copy-1", "a.md", [{ content: duplicated }]);
    await index("copy-2", "b.md", [{ content: duplicated }]);
    await index("other", "c.md", [{ content: "a cat video of the cat" }, { content: "the dog chases the cat" }]);
    const chat = new FakeChatModel("Answer [1][2][3].");
    const { useCase } = createUseCase(chat);

    const result = await useCase.execute({ userId: "user-1", question: "what does the cat do" });

    const prompt = chat.calls[0][1].content;
    const promptNumbers = [...prompt.matchAll(/^\[(\d+)\] /gm)].map((match) => Number(match[1]));
    const listed = [...formatAnswer(result).matchAll(/^\[(\d+)\] (\S+)/gm)].map((match) => [Number(match[1]), match[2]]);

    expect(result.sources.length).toBeGreaterThan(0);
    expect(promptNumbers).toEqual(result.sources.map((_, index) => index + 1));
    expect(result.sources.map((source) => source.rank)).toEqual(promptNumbers);
    expect(listed.map(([number]) => number)).toEqual(promptNumbers);
    // The i-th excerpt of the prompt and the i-th listed source are the same chunk of the same file.
    const promptFiles = [...prompt.matchAll(/^\[\d+\] (\S+?),/gm)].map((match) => match[1]);
    expect(listed.map(([, file]) => file)).toEqual(promptFiles);
    // The exact duplicate was skipped, so at most one of the two copies is cited.
    expect(promptFiles.filter((file) => file === "a.md" || file === "b.md")).toHaveLength(1);
  });
});

describe("answer grounding", () => {
  async function ask(answer: string) {
    await index("doc", "pets.md", [{ content: "the cat sleeps" }, { content: "the cat eats" }]);
    const { useCase, warn } = createUseCase(new FakeChatModel(answer));
    const result = await useCase.execute({ userId: "user-1", question: "what does the cat do" });
    return { result, warn };
  }

  it("accepts references to sources that were in the context", async () => {
    const { result, warn } = await ask("The cat sleeps [1] and eats [2].");

    expect(result.answer).toBe("The cat sleeps [1] and eats [2].");
    expect(result.citations).toEqual({ cited: [1, 2], removed: [] });
    expect(warn).toEqual([]);
  });

  it("removes a reference to a source that does not exist and records that it did", async () => {
    const { result, warn } = await ask("The cat sleeps [1], definitely [99].");

    expect(result.answer).toBe("The cat sleeps [1], definitely.");
    expect(result.citations).toEqual({ cited: [1], removed: [99] });
    expect(warn).toHaveLength(1);
    expect(warn[0].fields).toMatchObject({ removedReferences: [99], sources: 2 });
    expect(JSON.stringify(warn[0].fields)).not.toContain("sleeps"); // ids and numbers only, never text
  });

  it("reports repeated references once and keeps them in the text", async () => {
    const { result } = await ask("Cats sleep [1]. Really [1]. And eat [2].");

    expect(result.answer).toBe("Cats sleep [1]. Really [1]. And eat [2].");
    expect(result.citations.cited).toEqual([1, 2]);
  });

  it("still delivers an answer that has no citations at all, and malformed brackets do not break the output", async () => {
    const { result } = await ask("The cat [sleeps [1 and ]eats[] [ ] [x]");

    expect(formatAnswer(result)).toContain("The cat [sleeps [1 and ]eats[] [ ] [x]");
    expect(result.citations).toEqual({ cited: [], removed: [] });
  });
});
