import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { ChatMessage, ChatModel } from "../../application/ports/chat-model.js";
import { ExternalServiceError } from "../../shared/errors.js";
import { readTextContent } from "./response-text.js";
import type { OperationOptions } from "../../shared/operation.js";
import { boundOutput } from "../../shared/output-budget.js";

/** The slice of a LangChain chat model this adapter needs (also what tests fake). */
export type InvokableChatModel = {
  invoke(messages: BaseMessage[], options?: OperationOptions): Promise<{ content: unknown; response_metadata?: unknown }>;
};

function toLangChainMessage(message: ChatMessage) {
  return message.role === "system" ? new SystemMessage(message.content) : new HumanMessage(message.content);
}

export class OpenAIChatModel implements ChatModel {
  constructor(private readonly model: InvokableChatModel) {}

  async complete(messages: ChatMessage[], options: OperationOptions = {}) {
    options.signal?.throwIfAborted();
    let text: string;

    try {
      const response = await this.model.invoke(messages.map(toLangChainMessage), options);
      const metadata = response.response_metadata;
      const exhausted = typeof metadata === "object" && metadata !== null && "finish_reason" in metadata && metadata.finish_reason === "length";
      text = readTextContent(response.content);
      if (text) text = boundOutput(text, undefined, exhausted);
    } catch (error) {
      options.signal?.throwIfAborted();
      throw new ExternalServiceError("openai", { cause: error });
    }

    if (!text) {
      throw new ExternalServiceError("openai", { cause: new Error("Chat model returned an empty response") });
    }

    return text;
  }
}

export function createOpenAIChatModel(options: { apiKey: string; model: string; timeoutMs: number; maxOutputTokens: number; fetchImpl?: typeof fetch }) {
  return new OpenAIChatModel(
    new ChatOpenAI({
      model: options.model,
      apiKey: options.apiKey,
      temperature: 0,
      timeout: options.timeoutMs,
      maxRetries: 2,
      maxTokens: options.maxOutputTokens,
      configuration: { fetch: options.fetchImpl },
    }),
  );
}
