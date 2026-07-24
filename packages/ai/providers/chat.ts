// One chat entry point driven by a model config, instead of a per-provider
// function with positional arguments and hardcoded generation options.

import { makeModelConfig, modelBaseUrl } from "../core/model.ts";
import { makeAuthHeaders, buildOpenAIChatBody, readOpenAIResult } from "./openai.ts";
import { makeMistralAuthHeaders, buildMistralChatBody, readMistralResult } from "./mistral.ts";
import { makeAiResult } from "../core/result.ts";

// Send `messages` using `cfg`. Unlike chatOpenAI / chatMistral this honours the
// config's temperature and maxTokens. An unroutable config (unknown provider,
// no baseUrl) comes back as a failed result rather than a guessed endpoint.
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
  // Everything else speaks the OpenAI wire format: "openai" itself, and any
  // OpenAI-compatible endpoint reached through baseUrl.
  let body = buildOpenAIChatBody(cfg.model, messages, cfg.temperature, cfg.maxTokens);
  let res = http.request(url, "POST", body, makeAuthHeaders(cfg.apiKey));
  return readOpenAIResult(res.status, res.ok, res.body);
}
