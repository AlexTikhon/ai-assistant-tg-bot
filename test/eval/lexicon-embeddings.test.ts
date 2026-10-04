import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "../../src/core/vectors.js";
import { LexiconEmbeddings } from "../../src/eval/lexicon-embeddings.js";

const lexicon = {
  feeding: ["feeder", "dispenser", "kibble"],
  blocked: ["jam", "jammed", "stuck"],
  tax: ["tax", "levy"],
};

const embeddings = new LexiconEmbeddings(lexicon);

describe("LexiconEmbeddings", () => {
  it("is deterministic and L2-normalized, with a fixed dimension", async () => {
    const [first] = await embeddings.embedDocuments(["The feeder is stuck"]);
    const [second] = await embeddings.embedDocuments(["The feeder is stuck"]);

    expect(first).toEqual(second);
    expect(first).toHaveLength(embeddings.dimension);
    expect(Math.hypot(...first)).toBeCloseTo(1);
    expect(await embeddings.embedQuery("The feeder is stuck")).toEqual(first);
  });

  it("puts synonyms close together although they share no word - what lexical search cannot do", async () => {
    const [chunk] = await embeddings.embedDocuments(["Clearing a jammed hopper in the feeder"]);
    const paraphrase = await embeddings.embedQuery("my dispenser is stuck");
    const unrelated = await embeddings.embedQuery("annual levy return");

    expect(cosineSimilarity(chunk, paraphrase)).toBeGreaterThan(0.4);
    expect(cosineSimilarity(chunk, paraphrase)).toBeGreaterThan(cosineSimilarity(chunk, unrelated) + 0.3);
  });

  it("also reacts - weakly - to exact words outside the lexicon, like a real model does", async () => {
    const [chunk] = await embeddings.embedDocuments(["ECONNRESET at the broker"]);
    const same = await embeddings.embedQuery("ECONNRESET");
    const other = await embeddings.embedQuery("ETIMEDOUT");

    expect(cosineSimilarity(chunk, same)).toBeGreaterThan(cosineSimilarity(chunk, other));
  });

  it("returns valid vectors even for text with no known word", async () => {
    const [vector] = await embeddings.embedDocuments(["???"]);

    expect(vector.every(Number.isFinite)).toBe(true);
    expect(vector).toHaveLength(embeddings.dimension);
  });

  it("names its model, so an index built with it can never be mixed with real embeddings", () => {
    expect(embeddings.model).toBe("eval-lexicon-v1");
  });
});
