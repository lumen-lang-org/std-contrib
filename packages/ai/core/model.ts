// A model configuration: everything needed to make a call, in one value.
//
// The per-provider entry points take (apiKey, model, messages) positionally and
// hardcode temperature and max_tokens, so those knobs are unreachable through
// them. A config carries the provider, the model name, the credential and the
// generation options together, so a call site names one thing instead of
// threading four arguments, and options are actually settable.

type AiModelConfig = {
  // "mistral" or "openai". Anything else needs an explicit baseUrl.
  provider: string,
  // The model name, e.g. "mistral-large-latest".
  model: string,
  apiKey: string,
  // "" means the provider's own endpoint; set it for an OpenAI-compatible
  // server (Ollama, Groq, vLLM, a gateway).
  baseUrl: string,
  temperature: number,
  maxTokens: int,
};

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const MISTRAL_BASE_URL = "https://api.mistral.ai/v1";

// A config with the usual defaults: temperature 0.7, max_tokens 1024, and the
// provider's own endpoint. Narrow it with the `with*` helpers below.
export function makeModelConfig(provider: string, model: string, apiKey: string): AiModelConfig {
  let cfg: AiModelConfig = {
    provider: provider,
    model: model,
    apiKey: apiKey,
    baseUrl: "",
    temperature: 0.7,
    maxTokens: 1024,
  };
  return cfg;
}

// Each helper returns a NEW config; nothing is mutated, matching the rest of
// the package.
export function modelWithTemperature(cfg: AiModelConfig, temperature: number): AiModelConfig {
  let out: AiModelConfig = {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    temperature: temperature,
    maxTokens: cfg.maxTokens,
  };
  return out;
}

export function modelWithMaxTokens(cfg: AiModelConfig, maxTokens: int): AiModelConfig {
  let out: AiModelConfig = {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    temperature: cfg.temperature,
    maxTokens: maxTokens,
  };
  return out;
}

export function modelWithBaseUrl(cfg: AiModelConfig, baseUrl: string): AiModelConfig {
  let out: AiModelConfig = {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: baseUrl,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  };
  return out;
}

export function modelWithApiKey(cfg: AiModelConfig, apiKey: string): AiModelConfig {
  let out: AiModelConfig = {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: apiKey,
    baseUrl: cfg.baseUrl,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  };
  return out;
}

// The endpoint a config actually calls: its own baseUrl when set, otherwise the
// provider default. An unknown provider with no baseUrl yields "", which the
// caller reports rather than guessing an endpoint.
export function modelBaseUrl(cfg: AiModelConfig): string {
  if (cfg.baseUrl != "") { return cfg.baseUrl; }
  if (cfg.provider == "mistral") { return MISTRAL_BASE_URL; }
  if (cfg.provider == "openai") { return OPENAI_BASE_URL; }
  return "";
}
