import type { Context } from "telegraf";
import type { SpeechToText } from "../../application/ports/speech-to-text.js";
import type { AnswerQuestionUseCase } from "../../application/use-cases/answer-question.use-case.js";
import { withChatAction } from "../chat-action.js";
import { downloadTelegramFile, tooLargeError } from "../download.js";
import type { DownloadLimits } from "../download.js";
import { messages } from "../ui/messages.js";
import { replyWithAnswer } from "./ask.handler.js";
import type { AnswerReplyOptions } from "./ask.handler.js";
import { operationSignal, operationStep } from "../../shared/operation.js";

/** A voice message: download, transcribe, then answer it like a typed question. */
export function createVoiceHandler(
  speechToText: SpeechToText,
  answerQuestion: AnswerQuestionUseCase,
  limits: DownloadLimits,
  replyOptions: AnswerReplyOptions = {},
) {
  return async (ctx: Context) => {
    const message = ctx.message;
    const voice = message && "voice" in message ? message.voice : undefined;

    if (!voice?.file_id) {
      await ctx.reply(messages.voiceMissing);
      return;
    }
    if (voice.file_size !== undefined && voice.file_size > limits.maxBytes) {
      throw tooLargeError(limits.maxBytes);
    }

    const transcript = await withChatAction(ctx, "typing", async () => {
      const data = await downloadTelegramFile(ctx, voice.file_id, limits);
      return operationStep(() => speechToText.transcribe({
        data,
        fileName: "voice.ogg",
        mimeType: voice.mime_type ?? "audio/ogg",
      }, { signal: operationSignal() }));
    });

    if (!transcript) {
      await ctx.reply(messages.voiceNotRecognized);
      return;
    }

    await replyWithAnswer(ctx, answerQuestion, transcript, replyOptions);
  };
}
