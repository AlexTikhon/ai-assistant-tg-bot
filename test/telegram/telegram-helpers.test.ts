import type { Context } from "telegraf";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/shared/errors.js";
import { getMessageText, parseAskDocArgs, parseCommandArgs, requireUserId } from "../../src/telegram/context.js";
import { MAX_MESSAGE_LENGTH, MAX_REPLY_CHARS, MAX_REPLY_MESSAGES, replyLongText, splitMessage } from "../../src/telegram/reply.js";
import { OUTPUT_TRUNCATED_NOTICE } from "../../src/shared/output-budget.js";

describe("splitMessage", () => {
  it("returns short text unchanged and nothing for empty text", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
    expect(splitMessage("   ")).toEqual([]);
  });

  it("rejects limits that could prevent progress on a surrogate pair", () => {
    for (const limit of [0, 1, -1, 1.5, NaN]) expect(() => splitMessage("😀", limit)).toThrow(RangeError);
  });

  it.each([
    "x".repeat(200_000),
    Array.from({ length: 20 }, () => "a".repeat(2001)).join("\n\n"),
    Array.from({ length: 9 }, () => "a".repeat(2995)).join("\n\n"),
  ])("bounds delivery and keeps the keyboard on its last actual part", async (text) => {
    const sent: Array<{ text: string; extra?: unknown }> = [];
    const ctx = { reply: async (text: string, extra?: unknown) => { sent.push({ text, extra }); } } as unknown as Context;
    const extra = { reply_markup: { inline_keyboard: [] } };
    await replyLongText(ctx, text, extra);
    expect(sent.length).toBeLessThanOrEqual(MAX_REPLY_MESSAGES);
    expect(sent.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(sent.at(-1)?.text).toContain(OUTPUT_TRUNCATED_NOTICE.trim());
    expect(sent.at(-1)?.extra).toBe(extra);
    expect(sent.slice(0, -1).every((item) => item.extra === undefined)).toBe(true);
    expect(sent.every((item) => item.text.length <= MAX_MESSAGE_LENGTH)).toBe(true);
  });

  it("splits large text into parts within the limit without losing content", () => {
    const paragraphs = Array.from({ length: 200 }, (_, i) => `Paragraph ${i}: ${"lorem ipsum ".repeat(20).trim()}`);
    const text = paragraphs.join("\n\n");

    const parts = splitMessage(text);

    expect(text.length).toBeGreaterThan(MAX_MESSAGE_LENGTH * 5);
    expect(parts.length).toBeGreaterThan(5);
    parts.forEach((part) => expect(part.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH));
    expect(parts.join("\n\n").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
  });

  it("prefers to break between paragraphs", () => {
    const first = "a".repeat(60);
    const second = "b".repeat(60);

    expect(splitMessage(`${first}\n\n${second}`, 100)).toEqual([first, second]);
  });

  it("falls back to word boundaries, then to a hard cut", () => {
    expect(splitMessage("one two three four five", 12)).toEqual(["one two", "three four", "five"]);
    expect(splitMessage("x".repeat(25), 10).map((part) => part.length)).toEqual([10, 10, 5]);
  });

  it("never splits a surrogate pair (emoji) when hard-cutting", () => {
    const parts = splitMessage("😀".repeat(20), 7);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part).toMatch(/^\p{Extended_Pictographic}+$/u);
      expect(part.length).toBeLessThanOrEqual(7);
    }
    expect(parts.join("")).toBe("😀".repeat(20));
  });

  it("replyLongText sends every part as its own message", async () => {
    const sent: string[] = [];
    const ctx = { reply: async (text: string) => void sent.push(text) } as unknown as Context;

    await replyLongText(ctx, `${"a".repeat(MAX_MESSAGE_LENGTH - 10)}\n\n${"b".repeat(MAX_MESSAGE_LENGTH - 10)}`);

    expect(sent).toHaveLength(2);
  });
});

describe("parseCommandArgs", () => {
  it("returns the text after the command", () => {
    expect(parseCommandArgs("/ask what is RAG?", "ask")).toBe("what is RAG?");
    expect(parseCommandArgs("/ASK   spaced  ", "ask")).toBe("spaced");
    expect(parseCommandArgs("/ask first line\nsecond line", "ask")).toBe("first line\nsecond line");
  });

  it("supports the /command@BotName form used in groups", () => {
    expect(parseCommandArgs("/delete@my_bot 123-abc", "delete")).toBe("123-abc");
  });

  it("returns an empty string without arguments or for another command", () => {
    expect(parseCommandArgs("/ask", "ask")).toBe("");
    expect(parseCommandArgs("/ask@my_bot", "ask")).toBe("");
    expect(parseCommandArgs("/asking something", "ask")).toBe("");
    expect(parseCommandArgs("/list", "ask")).toBe("");
  });
});

describe("parseAskDocArgs", () => {
  it("splits the document id from the question, whatever the spacing", () => {
    expect(parseAskDocArgs("/askdoc abc-123 what is RAG?")).toEqual({ documentId: "abc-123", question: "what is RAG?" });
    expect(parseAskDocArgs("/askdoc@my_bot   abc-123    spaced   out  ")).toEqual({ documentId: "abc-123", question: "spaced   out" });
    expect(parseAskDocArgs("/askdoc abc-123\nfirst line\nsecond line")).toEqual({ documentId: "abc-123", question: "first line\nsecond line" });
  });

  it("is undefined when the id or the question is missing, or the text is another command", () => {
    for (const text of ["/askdoc", "/askdoc   ", "/askdoc abc-123", "/askdoc abc-123   ", "/ask abc-123 what?", "/askdocs abc-123 what?"]) {
      expect(parseAskDocArgs(text), text).toBeUndefined();
    }
  });
});

describe("requireUserId / getMessageText", () => {
  it("returns the Telegram user id as a string", () => {
    expect(requireUserId({ from: { id: 42 } } as unknown as Context)).toBe("42");
  });

  it('never turns a missing user into the string "undefined"', () => {
    expect(() => requireUserId({} as unknown as Context)).toThrow(ValidationError);
    expect(() => requireUserId({ from: undefined } as unknown as Context)).toThrow(/identify you/);
  });

  it("reads trimmed text and returns an empty string for non-text messages", () => {
    expect(getMessageText({ message: { text: "  hi  " } } as unknown as Context)).toBe("hi");
    expect(getMessageText({ message: { voice: {} } } as unknown as Context)).toBe("");
    expect(getMessageText({} as unknown as Context)).toBe("");
  });
});
