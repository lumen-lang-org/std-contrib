// Provider-neutral chat request helpers.

import { systemMessage } from "./messages.ts";

type LumenAiChatRequest = {
  provider: string,
  model: string,
  messages: LumenAiMessage[],
  temperature: number,
  max_tokens: int,
};

export function buildChatRequest(provider: string, model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): LumenAiChatRequest {
  return {
    provider: provider,
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: maxTokens,
  };
}
