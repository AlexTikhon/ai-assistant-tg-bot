import { describe, expect, it } from "vitest";
import { boundaryOverlap, trimChunkOverlap } from "../../src/core/chunk-overlap.js";
import { splitText } from "../../src/core/text-splitter.js";

describe("boundaryOverlap", () => {
  it("returns the length of the longest suffix of the first text that starts the second", () => {
    expect(boundaryOverlap("alpha beta gamma delta epsilon", "gamma delta epsilon zeta eta", 100, 5)).toBe(
      "gamma delta epsilon".length,
    );
  });

  it("returns 0 when there is no overlap or it is shorter than the minimum", () => {
    expect(boundaryOverlap("hello world", "something else", 100, 4)).toBe(0);
    expect(boundaryOverlap("ends with ab", "ab continues", 100, 4)).toBe(0);
  });

  it("never looks further than maxChars", () => {
    const text = `${"x".repeat(50)} tail text here`;

    expect(boundaryOverlap(text, `${text} and more`, 10, 4)).toBe(0);
  });
});

describe("trimChunkOverlap", () => {
  const chunk = (chunkIndex: number, content: string) => ({ chunkIndex, content });

  it("removes the repeated overlap from consecutive chunks", () => {
    const texts = trimChunkOverlap(
      [chunk(0, "one two three four five six"), chunk(1, "four five six seven eight nine")],
      50,
      5,
    );

    expect(texts).toEqual(["one two three four five six", "seven eight nine"]);
  });

  it("does not trim between chunks that are not neighbours", () => {
    const texts = trimChunkOverlap([chunk(0, "aaa bbb ccc ddd"), chunk(2, "bbb ccc ddd eee")], 50, 5);

    expect(texts).toEqual(["aaa bbb ccc ddd", "bbb ccc ddd eee"]);
  });

  it("keeps legitimately repeated content that is not at a chunk boundary", () => {
    const repeated = "The same sentence appears twice.";
    const texts = trimChunkOverlap(
      [chunk(0, `${repeated} Middle part. ${repeated}`), chunk(1, "Unrelated next chunk.")],
      100,
      5,
    );

    expect(texts[0]).toBe(`${repeated} Middle part. ${repeated}`);
    expect(texts[1]).toBe("Unrelated next chunk.");
  });

  it("is a no-op when the configured overlap is 0", () => {
    const input = [chunk(0, "a b c d e f g h"), chunk(1, "e f g h i j k l")];

    expect(trimChunkOverlap(input, 0, 5)).toEqual(input.map((item) => item.content));
  });

  it("reconstructs the original text from the output of the real splitter", () => {
    const sentences = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} talks about topic ${i * 7} in detail.`);
    const original = sentences.join(" ");
    const chunks = splitText(original, { chunkSize: 300, chunkOverlap: 80 });
    expect(chunks.length).toBeGreaterThan(3);

    const joined = trimChunkOverlap(chunks, 80).join(" ");

    expect(joined.split(/\s+/)).toEqual(original.split(/\s+/));
    expect(chunks.reduce((sum, item) => sum + item.content.length, 0)).toBeGreaterThan(joined.length);
  });
});
