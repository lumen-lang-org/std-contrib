// Provider selection helpers.

import { systemMessage } from "./messages.ts";
import { buildOpenAIChatBody } from "./openai.ts";
import { buildMistralChatBody } from "./mistral.ts";

export function buildProviderChatBody(provider: string, model: string, messages: LumenAiMessage[], temperature: number, maxTokens: int): string {
  if (provider == "mistral") {
    return buildMistralChatBody(model, messages, temperature, maxTokens);
  }
  if (provider == "openai" || provider == "openai-compatible") {
    return buildOpenAIChatBody(model, messages, temperature, maxTokens);
  }
  return "";
}
