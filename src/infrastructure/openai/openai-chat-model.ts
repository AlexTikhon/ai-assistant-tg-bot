import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { ChatMessage, ChatModel } from "../../application/ports/chat-model.js";
import { ExternalServiceError } from "../../shared/errors.js";
import { readTextContent } from "./response-text.js";

/** The slice of a LangChain chat model this adapter needs (also what tests fake). */
export type InvokableChatModel = {
  invoke(messages: BaseMessage[]): Promise<{ content: unknown }>;
};

function toLangChainMessage(message: ChatMessage) {
  return message.role === "system" ? new SystemMessage(message.content) : new HumanMessage(message.content);
}

export class OpenAIChatModel implements ChatModel {
  constructor(private readonly model: InvokableChatModel) {}

  async complete(messages: ChatMessage[]) {
    let text: string;

    try {
      const response = await this.model.invoke(messages.map(toLangChainMessage));
      text = readTextContent(response.content);
    } catch (error) {
      throw new ExternalServiceError("openai", { cause: error });
    }

    if (!text) {
      throw new ExternalServiceError("openai", { cause: new Error("Chat model returned an empty response") });
    }

    return text;
  }
}

export function createOpenAIChatModel(options: { apiKey: string; model: string; timeoutMs: number }) {
  return new OpenAIChatModel(
    new ChatOpenAI({
      model: options.model,
      apiKey: options.apiKey,
      temperature: 0,
      timeout: options.timeoutMs,
      maxRetries: 2,
    }),
  );
}
