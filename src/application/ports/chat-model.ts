export type ChatMessage = {
  role: "system" | "user";
  content: string;
};

/** A text-in/text-out chat completion provider. */
export interface ChatModel {
  /** Returns the assistant's reply as plain text. Throws ExternalServiceError on provider failures. */
  complete(messages: ChatMessage[]): Promise<string>;
}
