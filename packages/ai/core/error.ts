// Provider-neutral error helpers.

export type ProviderError = {
  provider: string,
  status: int,
  message: string,
  raw: string,
};

export function makeProviderError(provider: string, status: int, message: string, raw: string): ProviderError {
  return {
    provider: provider,
    status: status,
    message: message,
    raw: raw,
  };
}
