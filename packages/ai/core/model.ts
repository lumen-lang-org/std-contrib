// A model configuration: everything needed to make a call, in one value.
// The per-provider entry points hardcode temperature and max_tokens; a config
// makes them settable.

export type ModelConfig = {
  // "mistral" or "openai". Anything else needs an explicit baseUrl.
  provider: string,
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

export function makeModelConfig(provider: string, model: string, apiKey: string): ModelConfig {
  let cfg: ModelConfig = {
    provider: provider,
    model: model,
    apiKey: apiKey,
    baseUrl: "",
    temperature: 0.7,
    maxTokens: 1024,
  };
  return cfg;
}

// records are immutable: each `with*` helper rebuilds the config rather than
// assigning a field.
export function modelWithTemperature(cfg: ModelConfig, temperature: number): ModelConfig {
  let out: ModelConfig = {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    temperature: temperature,
    maxTokens: cfg.maxTokens,
  };
  return out;
}

export function modelWithMaxTokens(cfg: ModelConfig, maxTokens: int): ModelConfig {
  let out: ModelConfig = {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    temperature: cfg.temperature,
    maxTokens: maxTokens,
  };
  return out;
}

export function modelWithBaseUrl(cfg: ModelConfig, baseUrl: string): ModelConfig {
  let out: ModelConfig = {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: cfg.apiKey,
    baseUrl: baseUrl,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  };
  return out;
}

export function modelWithApiKey(cfg: ModelConfig, apiKey: string): ModelConfig {
  let out: ModelConfig = {
    provider: cfg.provider,
    model: cfg.model,
    apiKey: apiKey,
    baseUrl: cfg.baseUrl,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  };
  return out;
}

// baseUrl when set, else the provider default. an unknown provider with no
// baseUrl yields "" — callers must report that, not guess an endpoint.
export function modelBaseUrl(cfg: ModelConfig): string {
  if (cfg.baseUrl != "") { return cfg.baseUrl; }
  if (cfg.provider == "mistral") { return MISTRAL_BASE_URL; }
  if (cfg.provider == "openai") { return OPENAI_BASE_URL; }
  return "";
}
