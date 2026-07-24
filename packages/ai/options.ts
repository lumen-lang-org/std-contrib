// Provider-neutral model option helpers.

type AiModelOptions = {
  temperature: number,
  max_tokens: int,
};

export function makeModelOptions(temperature: number, maxTokens: int): AiModelOptions {
  return {
    temperature: temperature,
    max_tokens: maxTokens,
  };
}

export function defaultModelOptions(): AiModelOptions {
  return makeModelOptions(0.7, 1024);
}
