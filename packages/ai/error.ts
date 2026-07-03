// Provider-neutral error helpers.

type LumenAiProviderError = {
  provider: string,
  status: int,
  message: string,
  raw: string,
};

export function makeProviderError(provider: string, status: int, message: string, raw: string): LumenAiProviderError {
  return {
    provider: provider,
    status: status,
    message: message,
    raw: raw,
  };
}
