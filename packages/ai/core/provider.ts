// Provider selection helpers.

import { systemMessage } from "./messages.ts";
import { buildOpenAIChatBody } from "../providers/openai.ts";
import { buildMistralChatBody } from "../providers/mistral.ts";

export function buildProviderChatBody(provider: string, model: string, messages: Message[], temperature: number, maxTokens: int): string {
  if (provider == "mistral") {
    return buildMistralChatBody(model, messages, temperature, maxTokens);
  }
  if (provider == "openai" || provider == "openai-compatible") {
    return buildOpenAIChatBody(model, messages, temperature, maxTokens);
  }
  return "";
}
