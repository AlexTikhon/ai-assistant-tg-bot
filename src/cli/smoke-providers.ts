import type { ChatMessage, ChatModel } from "../application/ports/chat-model.js";
import type { EmbeddingsProvider } from "../application/ports/embeddings-provider.js";
import type { SpeechToText } from "../application/ports/speech-to-text.js";
import type { Providers } from "../composition-root.js";

const TOKEN = /[\p{L}\p{N}]+/gu;
const DIMENSIONS = 128;

/** FNV-1a over UTF-16 code units: stable across platforms and runs. */
function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value = Math.imul(value ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return value;
}

/**
 * Offline stand-in for an embeddings model: a hashed bag of words, L2-normalized, so texts that share words are close in
 * cosine similarity. Deterministic, free, no network. It exists to exercise the real pipeline (storage, FTS, retrieval, citations)
 * in `npm run smoke` and in tests; it says nothing about the quality of real embeddings.
 */
export class HashedEmbeddings implements EmbeddingsProvider {
  readonly model = "smoke-hashed-v1";
  /** Number of texts embedded, for assertions that nothing was re-embedded. */
  calls = 0;

  private embed(text: string) {
    const vector = new Array<number>(DIMENSIONS).fill(0);
    for (const word of text.toLowerCase().match(TOKEN) ?? []) {
      vector[hash(word) % DIMENSIONS] += 1;
    }
    const norm = Math.hypot(...vector);
    return norm === 0 ? vector.map((_, index) => (index === 0 ? 1 : 0)) : vector.map((value) => value / norm);
  }

  async embedDocuments(texts: string[]) {
    this.calls += texts.length;
    return texts.map((text) => this.embed(text));
  }

  async embedQuery(text: string) {
    this.calls += 1;
    return this.embed(text);
  }
}

/** Answers with a fixed sentence that cites the first excerpt it was given. Records what it was asked. */
export class ScriptedChatModel implements ChatModel {
  calls: ChatMessage[][] = [];

  async complete(messages: ChatMessage[]) {
    this.calls.push(messages);
    return "Based on your documents, here is the answer [1].";
  }
}

export class NoSpeech implements SpeechToText {
  async transcribe(): Promise<string> {
    throw new Error("Speech transcription is not available offline.");
  }
}

/** The providers of `npm run smoke`: nothing leaves the process. */
export function createOfflineProviders(): Providers & { embeddings: HashedEmbeddings; chatModel: ScriptedChatModel } {
  return { embeddings: new HashedEmbeddings(), chatModel: new ScriptedChatModel(), speechToText: new NoSpeech() };
}
