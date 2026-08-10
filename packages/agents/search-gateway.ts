// The pure parts of the search gateway — where the corpus lives and how a
// caller's key arrives — kept out of api.ts so they can be tested without a
// running server.
//
// The gateway itself (the /v1 routes and the playground) is a thin door in
// api.ts: it authenticates, then forwards the query to the real search service
// on the data node. Nothing here reaches the network; these only decide the
// address to reach and read the credential a request presented.

// Where /search, /retrieve and /suggest actually live. The data node's API,
// on the tailnet — overridable so a different deployment (or a test) can point
// the gateway somewhere else without a recompile.
export const DEFAULT_UPSTREAM: string = "http://100.110.210.29:8080";

export function upstreamBase(): string {
  let e = (process.env("AGENTS_SEARCH_UPSTREAM") ?? "").trim();
  return e != "" ? e : DEFAULT_UPSTREAM;
}

// The secret a caller presented, from either door the gateway honours:
//   Authorization: Bearer jl_...
//   X-API-Key: jl_...
// "" when neither carries one. The scheme match is case-insensitive because
// clients spell "Bearer" every way there is.
export function presentedKey(authorization: string, apiKeyHeader: string): string {
  let a = authorization.trim();
  if (a.length >= 7 && a.substring(0, 7).toLowerCase() == "bearer ") {
    return a.substring(7).trim();
  }
  return apiKeyHeader.trim();
}

// The three products the gateway forwards, and the only path tails it will
// build — a guard against forwarding an arbitrary path to the upstream.
export function isProduct(p: string): bool {
  return p == "search" || p == "retrieve" || p == "suggest";
}
