// Provider-neutral model option helpers.

type ModelOptions = {
  temperature: number,
  max_tokens: int,
};

export function makeModelOptions(temperature: number, maxTokens: int): ModelOptions {
  return {
    temperature: temperature,
    max_tokens: maxTokens,
  };
}

export function defaultModelOptions(): ModelOptions {
  return makeModelOptions(0.7, 1024);
}
