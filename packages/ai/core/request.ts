// Provider-neutral chat request helpers.

import { systemMessage } from "./messages.ts";

export type ChatRequest = {
  provider: string,
  model: string,
  messages: Message[],
  temperature: number,
  max_tokens: int,
};

export function buildChatRequest(provider: string, model: string, messages: Message[], temperature: number, maxTokens: int): ChatRequest {
  return {
    provider: provider,
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
  };
}
