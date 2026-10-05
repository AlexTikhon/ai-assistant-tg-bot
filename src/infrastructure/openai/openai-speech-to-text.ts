import type { AudioInput, SpeechToText } from "../../application/ports/speech-to-text.js";
import { ExternalServiceError } from "../../shared/errors.js";
import { HttpStatusError, parseRetryAfter, withRetry } from "../../shared/retry.js";
import type { RetryOptions } from "../../shared/retry.js";
import { operationStep } from "../../shared/operation.js";
import type { OperationOptions } from "../../shared/operation.js";

const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";

type Options = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Bounded retry of transient failures (429, 5xx, network resets, timeouts). Never retries 401/403/other 4xx. */
  retry?: RetryOptions;
};

/** Speech-to-text through the OpenAI transcription endpoint. */
export class OpenAISpeechToText implements SpeechToText {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Options) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(audio: AudioInput, options: OperationOptions = {}) {
    options.signal?.throwIfAborted();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }), audio.fileName);
    form.append("model", this.options.model);
    form.append("response_format", "json");

    let body: unknown;
    try {
      // A transcription is a pure function of the audio: repeating it after a transient failure is safe. The
      // timeout applies to each attempt; the number of attempts and the waits between them are bounded.
      body = await withRetry(async () => {
        const timeout = AbortSignal.timeout(this.options.timeoutMs);
        const attempt = await this.fetchImpl(TRANSCRIPTIONS_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.options.apiKey}` },
          body: form,
          signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        });
        if (!attempt.ok) {
          await attempt.body?.cancel().catch(() => undefined);
          throw new HttpStatusError(`Transcription request failed with status ${attempt.status}`, {
            status: attempt.status,
            retryAfterMs: parseRetryAfter(attempt.headers.get("retry-after")),
          });
        }
        return operationStep(() => attempt.json(), options.signal);
      }, { ...this.options.retry, signal: options.signal ?? this.options.retry?.signal });
    } catch (error) {
      options.signal?.throwIfAborted();
      // Timeouts surface as TimeoutError/AbortError; network failures as TypeError; others as HttpStatusError.
      throw new ExternalServiceError("openai", { cause: error });
    }

    const text = typeof body === "object" && body !== null && "text" in body ? body.text : undefined;
    if (typeof text !== "string") {
      throw new ExternalServiceError("openai", {
        cause: new Error("Transcription response did not contain text"),
      });
    }

    return text.trim();
  }
}
