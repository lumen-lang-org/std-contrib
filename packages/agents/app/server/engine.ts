// Where the engine is, said once.
//
// Two things on this server talk to the agents API: the proxy the browser's
// own fetches go through (server/api-proxy.ts) and the poller that feeds the
// socket (server/sockets.ts). They must agree about the address, so it is
// resolved here rather than twice.
//
// Deliberately free of node-only imports. api-proxy.ts needs `node:http` and
// can never be reached from a browser module; sockets.ts is re-exported from
// pages/index.ts, which IS a browser module, so anything it pulls in has to
// survive being bundled for a page that will never call it.

/** The agents API's origin, and its path prefix if it has one. */
export function engineTarget(): URL {
  return new URL(process.env.AGENTS_API ?? "http://127.0.0.1:8100");
}

// An AGENTS_API with a path — `http://host/agents` — prefixes every proxied
// request. Its trailing slash would otherwise double up against the leading
// slash of the rewritten path and produce `//threads`, which some routers
// treat as a different route than `/threads`.
export function stripTrailingSlash(pathname: string): string {
  return pathname === "/" ? "" : pathname.replace(/\/+$/, "");
}

/** An absolute URL for an engine route written the way api.ts writes it. */
export function engineUrl(path: string): string {
  const base = engineTarget();
  return new URL(stripTrailingSlash(base.pathname) + path, base.origin).toString();
}
