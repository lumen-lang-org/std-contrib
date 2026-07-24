// Provider-neutral chat request helpers.

import { systemMessage } from "./messages.ts";

type AiChatRequest = {
  provider: string,
  model: string,
  messages: AiMessage[],
  temperature: number,
  max_tokens: int,
};

export function buildChatRequest(provider: string, model: string, messages: AiMessage[], temperature: number, maxTokens: int): AiChatRequest {
  return {
    provider: provider,
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
  };
}
