// single chat entry point, routed by a model config.

import { makeModelConfig, modelBaseUrl } from "../core/model.ts";
import { makeAuthHeaders, buildOpenAIChatBody, readOpenAIResult } from "./openai.ts";
import { makeMistralAuthHeaders, buildMistralChatBody, readMistralResult } from "./mistral.ts";
import { makeAiResult } from "../core/result.ts";

// honours cfg's temperature and maxTokens, which runOpenAIChat / runMistralChat
// hardcode. an unroutable config fails rather than guessing an endpoint.
export function runConfiguredChat(cfg: AiModelConfig, messages: AiMessage[]): AiResult {
  let base = modelBaseUrl(cfg);
  if (base == "") {
    return makeAiResult(0, false, "", "unroutable model config: provider \"" + cfg.provider + "\" has no default endpoint — set a baseUrl");
  }
  let url = base + "/chat/completions";
  if (cfg.provider == "mistral") {
    let body = buildMistralChatBody(cfg.model, messages, cfg.temperature, cfg.maxTokens);
    let res = http.request(url, "POST", body, makeMistralAuthHeaders(cfg.apiKey));
    return readMistralResult(res.status, res.ok, res.body);
  }
  // everything else speaks the OpenAI wire format, including any
  // OpenAI-compatible endpoint reached through baseUrl.
  let body = buildOpenAIChatBody(cfg.model, messages, cfg.temperature, cfg.maxTokens);
  let res = http.request(url, "POST", body, makeAuthHeaders(cfg.apiKey));
  return readOpenAIResult(res.status, res.ok, res.body);
}
