import type { AudioInput, SpeechToText } from "../../application/ports/speech-to-text.js";
import { ExternalServiceError } from "../../shared/errors.js";

const TRANSCRIPTIONS_URL = "https://api.openai.com/v1/audio/transcriptions";

type Options = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
};

/** Speech-to-text through the OpenAI transcription endpoint. */
export class OpenAISpeechToText implements SpeechToText {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: Options) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async transcribe(audio: AudioInput) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio.data)], { type: audio.mimeType }), audio.fileName);
    form.append("model", this.options.model);
    form.append("response_format", "json");

    let response: Response;
    try {
      response = await this.fetchImpl(TRANSCRIPTIONS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      // Timeouts surface as TimeoutError/AbortError; network failures as TypeError.
      throw new ExternalServiceError("openai", { cause: error });
    }

    if (!response.ok) {
      throw new ExternalServiceError("openai", {
        cause: new Error(`Transcription request failed with status ${response.status}`),
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
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
