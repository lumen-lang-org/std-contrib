export const DEFAULT_UPSTREAM: string = "http://100.110.210.29:8080";

export function upstreamBase(): string {
  let e = (process.env("AGENTS_SEARCH_UPSTREAM") ?? "").trim();
  return e != "" ? e : DEFAULT_UPSTREAM;
}

export function presentedKey(authorization: string, apiKeyHeader: string): string {
  let a = authorization.trim();
  if (a.length >= 7 && a.substring(0, 7).toLowerCase() == "bearer ") {
    return a.substring(7).trim();
  }
  return apiKeyHeader.trim();
}

export function isProduct(p: string): bool {
  return p == "search" || p == "retrieve" || p == "suggest";
}
