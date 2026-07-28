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

// One sentence a caller can print or log: which provider, which URL, which
// status, and the provider's own words.
//
// This is what a failed call reports instead of a zero value. `status -1,
// content "", raw ""` is what a refused connection produced, and it reads
// exactly like a model that answered with nothing — the two need different
// responses from a caller, so they have to look different.
export function providerFailureText(err: ProviderError, url: string): string {
  let reason = err.message;
  if (reason == "") {
    if (err.status < 0) {
      reason = "no response — the connection, DNS lookup or TLS handshake failed";
    } else {
      reason = "the response body named no error";
    }
  }
  return err.provider + " request to " + url + " failed with status " + err.status + ": " + reason;
}
