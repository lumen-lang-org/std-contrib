// single chat entry point, routed by a model config.

import { makeModelConfig, modelBaseUrl } from "../core/model.ts";
import { makeAuthHeaders, buildOpenAIChatBody, openAICallResult } from "./openai.ts";
import { makeMistralAuthHeaders, buildMistralChatBody, mistralCallResult } from "./mistral.ts";
import { makeAiResult } from "../core/result.ts";

// honours cfg's temperature and maxTokens, which runOpenAIChat / runMistralChat
// hardcode. an unroutable config fails rather than guessing an endpoint, and a
// call that fails on the wire says so in a sentence naming the provider, the
// URL and the reason — the same shape the unroutable branch below writes.
export function runConfiguredChat(cfg: ModelConfig, messages: Message[]): Result {
  let base = modelBaseUrl(cfg);
  if (base == "") {
    return makeAiResult(0, false, "", "unroutable model config: provider \"" + cfg.provider + "\" has no default endpoint — set a baseUrl");
  }
  let url = base + "/chat/completions";
  if (cfg.provider == "mistral") {
    let body = buildMistralChatBody(cfg.model, messages, cfg.temperature, cfg.maxTokens);
    let res = http.request(url, "POST", body, makeMistralAuthHeaders(cfg.apiKey));
    return mistralCallResult(url, res.status, res.ok, res.body);
  }
  // everything else speaks the OpenAI wire format, including any
  // OpenAI-compatible endpoint reached through baseUrl.
  let body = buildOpenAIChatBody(cfg.model, messages, cfg.temperature, cfg.maxTokens);
  let res = http.request(url, "POST", body, makeAuthHeaders(cfg.apiKey));
  return openAICallResult(url, res.status, res.ok, res.body);
}
