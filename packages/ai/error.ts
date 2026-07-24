// Provider-neutral error helpers.

type AiProviderError = {
  provider: string,
  status: int,
  message: string,
  raw: string,
};

export function makeProviderError(provider: string, status: int, message: string, raw: string): AiProviderError {
  return {
    provider: provider,
    status: status,
    message: message,
    raw: raw,
  };
}
