export type AudioInput = {
  data: Buffer;
  fileName: string;
  mimeType: string;
};

export interface SpeechToText {
  /** Returns the transcription (possibly empty). Throws ExternalServiceError on provider failures. */
  transcribe(audio: AudioInput): Promise<string>;
}
