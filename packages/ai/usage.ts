// Provider-neutral token usage helpers.

type LumenAiTokenUsage = {
  prompt_tokens: int,
  completion_tokens: int,
  total_tokens: int,
};

export function makeTokenUsage(promptTokens: int, completionTokens: int, totalTokens: int): LumenAiTokenUsage {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}
