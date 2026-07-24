// Shared HTTP header helpers for provider APIs.

export function bearerJsonHeaders(apiKey: string): Map<string, string> {
  const headers = new Map<string, string>();
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", "Bearer " + apiKey);
  return headers;
}
