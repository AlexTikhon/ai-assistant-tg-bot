import type { Context } from "telegraf";
import { describe, expect, it, vi } from "vitest";
import type { AnswerQuestionUseCase } from "../../src/application/use-cases/answer-question.use-case.js";
import type { RecordFeedbackUseCase } from "../../src/application/use-cases/record-feedback.use-case.js";
import { runWithRequestId } from "../../src/shared/request-context.js";
import { createFeedbackHandler, FEEDBACK_PATTERN } from "../../src/telegram/handlers/feedback.handler.js";
import { replyWithAnswer } from "../../src/telegram/handlers/ask.handler.js";
import { feedbackKeyboard } from "../../src/telegram/ui/keyboards.js";
import { MAX_MESSAGE_LENGTH, replyLongText } from "../../src/telegram/reply.js";

describe("feedbackKeyboard", () => {
  it("offers a thumbs-up and a thumbs-down whose callback data fits Telegram's 64 bytes and round-trips", () => {
    const keyboard = feedbackKeyboard("abcd1234");
    const buttons = keyboard.reply_markup.inline_keyboard[0];

    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(Buffer.byteLength((button as { callback_data: string }).callback_data)).toBeLessThanOrEqual(64);
      expect(FEEDBACK_PATTERN.test((button as { callback_data: string }).callback_data)).toBe(true);
    }
    expect(buttons.map((button) => (button as { callback_data: string }).callback_data)).toEqual(["fb:g:abcd1234", "fb:b:abcd1234"]);
  });
});

describe("feedback callback handler", () => {
  function callback(data: string, userId: number | undefined = 42) {
    const calls = { answered: [] as unknown[], edited: [] as unknown[], replies: [] as string[] };
    const ctx = {
      from: userId === undefined ? undefined : { id: userId },
      match: FEEDBACK_PATTERN.exec(data),
      answerCbQuery: async (text?: string) => void calls.answered.push(text),
      editMessageReplyMarkup: async (markup: unknown) => void calls.edited.push(markup),
      reply: async (text: string) => void calls.replies.push(text),
    } as unknown as Context;
    return { ctx, calls };
  }

  it("records the rating for the user who pressed, thanks them and removes the buttons", async () => {
    const execute = vi.fn(async () => undefined);
    const handler = createFeedbackHandler({ execute } as unknown as RecordFeedbackUseCase);
    const { ctx, calls } = callback("fb:b:abcd1234");

    await handler(ctx);

    expect(execute).toHaveBeenCalledWith({ userId: "42", requestId: "abcd1234", rating: "bad" });
    expect(calls.answered).toEqual(["Thanks for the feedback!"]);
    expect(calls.edited).toEqual([undefined]);
  });

  it("maps g to good and b to bad, and ignores data that does not match", async () => {
    const execute = vi.fn(async () => undefined);
    const handler = createFeedbackHandler({ execute } as unknown as RecordFeedbackUseCase);

    await handler(callback("fb:g:abcd1234").ctx);

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ rating: "good" }));
    expect(FEEDBACK_PATTERN.test("fb:x:abcd1234")).toBe(false);
    expect(FEEDBACK_PATTERN.test("fb:g:ABCD1234")).toBe(false);
    expect(FEEDBACK_PATTERN.test("fb:g:abcd12345")).toBe(false);
  });

  it("still closes the spinner and the buttons when storing fails, without telling the user about internals", async () => {
    const execute = vi.fn(async () => Promise.reject(new Error("database is locked")));
    const handler = createFeedbackHandler({ execute } as unknown as RecordFeedbackUseCase);
    const { ctx, calls } = callback("fb:g:abcd1234");

    await expect(handler(ctx)).rejects.toThrow("database is locked"); // the error boundary logs it and sends the generic message

    expect(calls.answered).toHaveLength(1);
  });
});

describe("answers with feedback buttons", () => {
  const answerQuestion = {
    execute: vi.fn(async () => ({ kind: "answered", answer: "yes", sources: [], citations: { cited: [], removed: [] } })),
  } as unknown as AnswerQuestionUseCase;

  function chat() {
    const sent: Array<{ text: string; extra?: { reply_markup?: unknown } }> = [];
    const ctx = {
      from: { id: 7 },
      sendChatAction: async () => undefined,
      reply: async (text: string, extra?: { reply_markup?: unknown }) => void sent.push({ text, extra }),
    } as unknown as Context;
    return { ctx, sent };
  }

  it("attaches the buttons to the answer when enabled, carrying the answer's request id", async () => {
    const { ctx, sent } = chat();

    await runWithRequestId("abcd1234", () => replyWithAnswer(ctx, answerQuestion, "q?", { feedbackButtons: true }));

    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0].extra?.reply_markup)).toContain("fb:g:abcd1234");
  });

  it("sends a plain answer, exactly as before, when feedback is off", async () => {
    const { ctx, sent } = chat();

    await runWithRequestId("abcd1234", () => replyWithAnswer(ctx, answerQuestion, "q?", { feedbackButtons: false }));

    expect(sent[0].extra).toBeUndefined();
  });

  it("puts the buttons on the last part only of a long answer", async () => {
    const sent: Array<{ text: string; extra?: unknown }> = [];
    const ctx = { reply: async (text: string, extra?: unknown) => void sent.push({ text, extra }) } as unknown as Context;

    await replyLongText(ctx, `${"a".repeat(MAX_MESSAGE_LENGTH - 10)}\n\n${"b".repeat(MAX_MESSAGE_LENGTH - 10)}`, { reply_markup: { inline_keyboard: [] } });

    expect(sent.map((message) => message.extra !== undefined)).toEqual([false, true]);
  });
});
