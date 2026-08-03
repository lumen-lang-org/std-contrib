// The search index's API, reachable from a browser that is not on the tailnet.
//
// The index lives on `joule-data` and answers on the tailnet only, with no
// auth of its own. The brief that specified this dashboard said to call it
// straight from the browser and add no proxy — which is right for an operator
// sitting on the tailnet, and wrong the moment any of it is public. A public
// analytics page cannot ask its readers to join a tailnet, so the console
// stands in front instead.
//
// That makes this file the security boundary, and it is written as one:
//
//   * an ALLOWLIST, not a pass-through. `/search-api/anything-else` is 404
//     here and never becomes a request upstream. api-proxy.ts forwards
//     `/api/*` to the engine wholesale, which is fine for a service that
//     authorises its own routes; this upstream authorises nothing, so the set
//     of things it can be asked is the set enumerated below.
//   * GET only, for the same reason. The upstream has writes we do not name
//     and must not acquire a way to reach them.
//   * two tiers. `/stats` and `/analytics` are aggregate counters about a
//     public web index — a document count and a language histogram give away
//     nothing about anybody — so they answer to everyone. The query endpoints
//     do not: `/search`, `/retrieve` and `/suggest` are the index itself, and
//     `/suggest` in particular is drawn partly from what people have already
//     searched for. Those stay behind the same operator check that guards the
//     model tables, which is why this middleware is spliced AFTER authChain.
//   * nothing of the caller travels upstream. No cookies, no `X-USER`, no
//     forwarded headers at all, and only the query parameters named below —
//     clamped. The upstream cannot be made to answer a question this file did
//     not ask.
//
// The cache is not a nicety either. It is what makes a public page safe to
// point at a single-box index: a thousand readers on the analytics page cost
// one upstream request per TTL, not a thousand. It is also why there is no
// rate limiter here — for the public tier there is nothing to limit, because
// the second reader in a window never reaches the network. The operator tier
// is uncached (a playground whose results are seconds stale is a broken
// playground) and gated instead.

import type { IncomingMessage, ServerResponse } from "node:http";

type Next = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/** Where the index answers. The tailnet address is the default rather than a
 *  requirement: the console reaches it from inside its container today, and a
 *  deployment that moves the index sets this instead of editing code. */
const BASE = (process.env.JOULE_SEARCH_API || "http://100.110.210.29:8080")
  .replace(/\/+$/, "");

const PREFIX = "/search-api";

/** How long the console may answer an aggregate from memory. Short enough that
 *  a corpus growing by hundreds of documents an hour still looks live, long
 *  enough that a page open in a hundred tabs is one request. */
const TTL_MS = 20_000;

/** A parameter this file will pass on, and what it will accept for it.
 *  `clamp` is applied to numbers; a string is truncated. Anything not listed
 *  for an endpoint is dropped silently — a caller cannot smuggle a parameter
 *  through by naming it. */
type Param =
  | { kind: "text"; max: number }
  | { kind: "int"; min: number; max: number };

const Q: Param = { kind: "text", max: 512 };
const FILTERS: Record<string, Param> = {
  lang: { kind: "text", max: 8 },
  country: { kind: "text", max: 8 },
  category: { kind: "text", max: 48 },
  site: { kind: "text", max: 253 },
};

interface Route {
  /** Path under the prefix, exactly. `/doc/` is the one prefix match. */
  path: string;
  /** Whether the caller has to be an operator. */
  operator: boolean;
  /** Cached for TTL_MS when true. Only ever the aggregates. */
  cache: boolean;
  params: Record<string, Param>;
}

const ROUTES: Route[] = [
  { path: "/healthz", operator: false, cache: false, params: {} },
  { path: "/stats", operator: false, cache: true, params: {} },
  { path: "/analytics", operator: false, cache: true, params: {} },
  {
    path: "/search",
    operator: true,
    cache: false,
    params: { q: Q, k: { kind: "int", min: 1, max: 50 }, ...FILTERS },
  },
  {
    path: "/retrieve",
    operator: true,
    cache: false,
    params: {
      q: Q,
      k: { kind: "int", min: 1, max: 20 },
      max_chars: { kind: "int", min: 500, max: 200_000 },
      ...FILTERS,
    },
  },
  {
    path: "/suggest",
    operator: true,
    cache: false,
    params: { q: Q, k: { kind: "int", min: 1, max: 20 } },
  },
];

/** `/doc/<hash>` is the one route whose interesting part is in the path. The
 *  hash is checked here rather than trusted: it is hex out of a `/retrieve`
 *  answer, so anything else is a caller inventing paths for the upstream. */
const DOC = /^\/doc\/([0-9a-f]{4,64})$/;

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

/** The operator test, deliberately identical to `guardConfigWrites` in
 *  pages/_middleware.ts — same field, same absence-is-refusal reading. It is
 *  not shared as a function because that file exports a chain rather than its
 *  predicates, and a copy of four lines is cheaper than an export that invites
 *  more of the middleware to be imported here.
 *
 *  `AUTH=none` has one operator who owns the box and nobody to tell them from,
 *  which is the reading `isAdmin(null)` already makes in src/api.ts. */
function isOperator(req: IncomingMessage): boolean {
  if ((process.env.AUTH || "none") === "none") return true;
  const held = (req as unknown as { nkAuth?: { user?: { roles?: unknown } } }).nkAuth;
  const roles = held?.user?.roles;
  return Array.isArray(roles) && roles.includes("admin");
}

function clean(value: string, spec: Param): string | null {
  if (spec.kind === "int") {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return null;
    return String(Math.min(spec.max, Math.max(spec.min, n)));
  }
  const text = value.slice(0, spec.max).trim();
  return text === "" ? null : text;
}

interface Hit { at: number; status: number; body: string }
const cache = new Map<string, Hit>();

async function upstream(path: string, search: string): Promise<Hit> {
  const url = BASE + path + (search === "" ? "" : "?" + search);
  // AbortSignal.timeout rather than a bare fetch: the index is one box on a
  // tailnet, and a console request that hangs on it holds a connection open
  // for as long as the socket lives. Ten seconds is generous for an endpoint
  // whose own `took_ms` is in the tens.
  const answer = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json" },
  });
  return { at: Date.now(), status: answer.status, body: await answer.text() };
}

export function searchProxy(): Middleware {
  return (req, res, next) => {
    const raw = req.url ?? "/";
    const [pathname, search = ""] = raw.split("?");
    if (pathname !== PREFIX && !pathname.startsWith(PREFIX + "/")) { next(); return; }

    const rest = pathname.slice(PREFIX.length) || "/";
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      json(res, 405, { error: "the index is read-only through here" });
      return;
    }

    const doc = DOC.exec(rest);
    const route = doc
      ? { path: rest, operator: true, cache: false, params: {} as Record<string, Param> }
      : ROUTES.find((r) => r.path === rest);
    if (!route) {
      json(res, 404, { error: "no such index route" });
      return;
    }
    if (route.operator && !isOperator(req)) {
      // 403 and not 404: a signed-in person looking at the dashboard should be
      // told they are not an operator, rather than shown a broken screen.
      json(res, 403, { error: "querying the index is an operator action" });
      return;
    }

    // Rebuilt from the allowlist rather than forwarded. Order is the route's,
    // not the caller's, so the same question always produces the same cache
    // key however the query string was written.
    const asked = new URLSearchParams(search);
    const sent = new URLSearchParams();
    for (const [name, spec] of Object.entries(route.params)) {
      const given = asked.get(name);
      if (given === null) continue;
      const value = clean(given, spec);
      if (value !== null) sent.append(name, value);
    }
    const query = sent.toString();

    if (route.cache) {
      const hit = cache.get(route.path + "?" + query);
      if (hit && Date.now() - hit.at < TTL_MS) {
        res.statusCode = hit.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        // Let a browser and any CDN in front hold it for the same window the
        // console does. Nothing here is per-caller, so a shared cache is
        // correct as well as cheap.
        res.setHeader("cache-control", `public, max-age=${Math.floor(TTL_MS / 1000)}`);
        res.end(hit.body);
        return;
      }
    }

    void upstream(route.path, query)
      .then((hit) => {
        if (route.cache && hit.status === 200) cache.set(route.path + "?" + query, hit);
        res.statusCode = hit.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader(
          "cache-control",
          route.cache ? `public, max-age=${Math.floor(TTL_MS / 1000)}` : "no-store",
        );
        res.end(hit.body);
      })
      .catch((err: unknown) => {
        // The one failure worth naming: the index is a single box on a tailnet
        // and it is allowed to be down. A page that says so is a page whose
        // reader stops debugging their own browser.
        // "The operation was aborted." is what AbortSignal.timeout says, and
        // it names the mechanism rather than the fact. A reader needs to know
        // the index went quiet, not that a signal fired.
        const raw = err instanceof Error ? err.message : String(err);
        const timedOut = err instanceof Error
          && (err.name === "TimeoutError" || /abort/i.test(raw));

        // Stale beats nothing on the public page. The index is one box that
        // crawls while it serves, and it does go quiet; a visitor who came to
        // see what the corpus looks like is better served by last hour's
        // numbers, labelled, than by an error where the numbers should be.
        // Only the cached tier can do this, which is only the aggregates —
        // there is no stale answer to a search, and pretending otherwise would
        // be showing results for a query nobody ran.
        const stale = route.cache ? cache.get(route.path + "?" + query) : undefined;
        if (stale && stale.status === 200) {
          res.statusCode = 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          // Seconds, so the page can say how old rather than only that it is
          // old. A reader deciding whether to trust a number wants the age.
          res.setHeader("x-index-stale", String(Math.round((Date.now() - stale.at) / 1000)));
          res.end(stale.body);
          return;
        }

        json(res, 503, {
          error: timedOut
            ? "the search index did not answer within 10s"
            : "the search index could not be reached",
          detail: timedOut ? `${route.path} timed out; /stats and /analytics may still be fine`
            : raw.slice(0, 200),
          upstream: BASE,
        });
      });
  };
}
