import { describe, expect, it } from "vitest";
import { splitText } from "../../src/core/text-splitter.js";

const options = { chunkSize: 200, chunkOverlap: 40 };

function paragraph(label: string, sentences: number) {
  return Array.from({ length: sentences }, (_, i) => `${label} sentence number ${i + 1} talks about something.`).join(" ");
}

describe("splitText", () => {
  it("keeps short text in a single chunk", () => {
    expect(splitText("Hello world.", options)).toEqual([{ chunkIndex: 0, content: "Hello world." }]);
  });

  it("returns nothing for empty or whitespace-only text", () => {
    expect(splitText("", options)).toEqual([]);
    expect(splitText("  \n\n  ", options)).toEqual([]);
  });

  it("never produces a chunk longer than chunkSize and numbers chunks sequentially", () => {
    const text = [paragraph("Alpha", 12), paragraph("Beta", 12), paragraph("Gamma", 12)].join("\n\n");
    const chunks = splitText(text, options);

    expect(chunks.length).toBeGreaterThan(3);
    chunks.forEach((chunk, index) => {
      expect(chunk.content.length).toBeLessThanOrEqual(options.chunkSize);
      expect(chunk.chunkIndex).toBe(index);
    });
  });

  it("does not cut words when whitespace is available", () => {
    const text = paragraph("Alpha", 20);
    const originalWords = new Set(text.split(/\s+/));

    for (const chunk of splitText(text, options)) {
      for (const word of chunk.content.split(/\s+/)) {
        expect(originalWords.has(word)).toBe(true);
      }
    }
  });

  it("prefers paragraph boundaries over cutting through a paragraph", () => {
    const first = "First paragraph. ".repeat(6).trim(); // ~101 chars
    const second = "Second paragraph. ".repeat(6).trim();
    const chunks = splitText(`${first}\n\n${second}`, { chunkSize: 150, chunkOverlap: 0 });

    expect(chunks.map((chunk) => chunk.content)).toEqual([first, second]);
  });

  it("repeats a word-aligned tail of the previous chunk as overlap", () => {
    const chunks = splitText(paragraph("Alpha", 20), options);

    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1].content;
      const firstWords = chunks[i].content.split(" ").slice(0, 3).join(" ");
      expect(previous).toContain(firstWords);
    }
  });

  it("produces no overlap when chunkOverlap is 0", () => {
    const chunks = splitText(paragraph("Alpha", 20), { chunkSize: 200, chunkOverlap: 0 });
    const joined = chunks.map((chunk) => chunk.content).join(" ");

    expect(joined.split(" ").length).toBe(paragraph("Alpha", 20).split(" ").length);
  });

  it("hard-splits a single oversized token without breaking surrogate pairs", () => {
    const chunks = splitText("😀".repeat(30), { chunkSize: 11, chunkOverlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Every chunk consists of whole emoji only: no lone high/low surrogate halves.
      expect(chunk.content).toMatch(/^\p{Extended_Pictographic}+$/u);
      expect(chunk.content.length).toBeLessThanOrEqual(11);
    }
  });

  it("covers the whole text: every sentence appears in at least one chunk", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Fact ${i} is important.`);
    const chunks = splitText(sentences.join(" "), options).map((chunk) => chunk.content);

    for (const sentence of sentences) {
      expect(chunks.some((chunk) => chunk.includes(sentence))).toBe(true);
    }
  });

  it("rejects invalid options", () => {
    expect(() => splitText("x", { chunkSize: 0, chunkOverlap: 0 })).toThrow(RangeError);
    expect(() => splitText("x", { chunkSize: 100, chunkOverlap: 100 })).toThrow(RangeError);
    expect(() => splitText("x", { chunkSize: 100, chunkOverlap: -1 })).toThrow(RangeError);
  });
});
