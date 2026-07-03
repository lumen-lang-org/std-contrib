// Provider-neutral model option helpers.

type LumenAiModelOptions = {
  temperature: number,
  max_tokens: int,
};

export function makeModelOptions(temperature: number, maxTokens: int): LumenAiModelOptions {
  return {
    temperature: temperature,
    max_tokens: maxTokens,
  };
}

export function defaultModelOptions(): LumenAiModelOptions {
  return makeModelOptions(0.7, 1024);
}
