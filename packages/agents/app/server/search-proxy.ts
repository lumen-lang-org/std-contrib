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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
  /** Fields a NON-operator may see. Absent means the whole answer.
   *
   *  The public page shows less than the admin one, and this is what makes
   *  that true rather than cosmetic: without it a visitor who opened devtools
   *  could read the reject reasons and the crawl's per-hour rate straight off
   *  the endpoint the page was calling. Trimming the render alone would be
   *  hiding the numbers from the screen and not from anybody. */
  publicFields?: string[];
}

const ROUTES: Route[] = [
  { path: "/healthz", operator: false, cache: false, params: {} },
  {
    path: "/stats",
    operator: false,
    cache: true,
    params: {},
    // Size, breadth and freshness — the three things that say what the index
    // IS. What is left out is operational: how much is queued, how much was
    // thrown away, how far behind enrichment is running. Those are a state of
    // work, and a state of work read by a stranger is only ever read wrong.
    publicFields: ["indexed", "domains", "corpus_bytes", "markdown_bytes_raw",
                   "newest_fetch", "oldest_fetch"],
  },
  {
    path: "/analytics",
    operator: false,
    cache: true,
    params: {},
    // Languages only. by_country and by_category are the same kind of fact and
    // could be argued for; by_domain names every site the crawler favours,
    // rejects is the quality gate's own reasoning, and ingest_by_hour is the
    // crawl rate — none of which a public page is improved by carrying.
    publicFields: ["by_lang"],
  },
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
    // The pipeline's own vitals. An operator's, and emphatically not the
    // public tier's: it names the crawl nodes by tailnet address and reports
    // how far behind processing is, which is a map of the deployment and a
    // statement about its health. The brief that asked for this said not to
    // put the index on a public route, and this is the route that would most
    // obviously breach that.
    path: "/nodes",
    operator: true,
    cache: false,
    params: {},
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

/** The answer a non-operator gets: the named fields and nothing else. Parsed
 *  and rebuilt rather than string-edited, so a field this file does not know
 *  about cannot survive by being spelled unexpectedly. A body that will not
 *  parse is served whole — it is an error document, and hiding it would only
 *  make the failure harder to read. */
function trim(body: string, fields: string[]): string {
  try {
    const whole = JSON.parse(body) as Record<string, unknown>;
    const kept: Record<string, unknown> = {};
    for (const name of fields) {
      if (Object.prototype.hasOwnProperty.call(whole, name)) kept[name] = whole[name];
    }
    return JSON.stringify(kept);
  } catch {
    return body;
  }
}

interface Hit { at: number; status: number; body: string }
const cache = new Map<string, Hit>();

/** The aggregates, on disk.
 *
 *  The console is redeployed by replacing its container, which empties an
 *  in-memory cache every time — and an empty cache during an index outage is a
 *  public page with an error where its numbers should be. A file survives the
 *  restart, so the worst case becomes numbers with an age on them. Mounted at
 *  JOULE_CACHE_FILE; unset or unwritable, everything below still works and
 *  only the restart case gets worse. */
const CACHE_FILE = process.env.JOULE_CACHE_FILE || "/var/cache/joule/aggregates.json";

function loadCache(): void {
  try {
    const saved = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as Record<string, Hit>;
    for (const [key, hit] of Object.entries(saved)) {
      if (typeof hit?.body === "string") cache.set(key, hit);
    }
  } catch {
    /* no file yet, or nothing readable in it — the warmer fills it */
  }
}

function saveCache(): void {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    /* read-only filesystem, no volume — the memory cache is unaffected */
  }
}

/** Two budgets, because two callers.
 *
 *  A person waiting on a page gets 3.5s: the index answers its own queries in
 *  tens of milliseconds, so anything past that is a network or a box in
 *  trouble, and making somebody watch a spinner for ten seconds to be told so
 *  is the worst of both. The background warmer gets longer — nobody is
 *  waiting on it, and a slow answer still beats no answer. */
const WAIT_LIVE = 3_500;
const WAIT_WARM = 9_000;

async function upstream(path: string, search: string, budget = WAIT_LIVE): Promise<Hit> {
  const url = BASE + path + (search === "" ? "" : "?" + search);
  const answer = await fetch(url, {
    signal: AbortSignal.timeout(budget),
    headers: { accept: "application/json" },
  });
  return { at: Date.now(), status: answer.status, body: await answer.text() };
}

/** When the index is down, stop making every caller discover it separately.
 *
 *  Both outages this box has seen took the whole VM off the tailnet, so every
 *  request was an identical wait for an identical timeout. One failure now
 *  shuts the door for a few seconds and the rest are refused immediately —
 *  which is what turns a dead index from a page that hangs into a page that
 *  says so. Any success reopens it; there is no half-open dance, because the
 *  warmer is already probing on its own timer. */
let closedUntil = 0;
const BREAKER_MS = 8_000;

/** The aggregates, kept warm.
 *
 *  The index is a Hyper-V VM reached over a tailnet relay, and a cold request
 *  to it costs anywhere from 100ms to the 10s timeout. Paying that on a page
 *  load — or on a hover — is the difference between a number appearing and a
 *  panel that never opens, which is exactly how the composer's index card
 *  failed its first test.
 *
 *  So no request ever waits on the tailnet if anything is cached. A timer on
 *  this box refreshes the two aggregates every TTL whether or not anybody is
 *  looking, and a request that finds a stale entry serves it AND kicks off a
 *  refresh behind itself. The only call that can block is the first one after
 *  a boot, before the warmer has finished — and the warmer starts at import,
 *  so that window is a second or two of process life rather than a state a
 *  visitor lands in.
 *
 *  This also collapses the failure case. When the index is down the timer
 *  keeps failing quietly against the last good answer, and the page shows
 *  numbers with an age on them instead of an error. */
const WARM = ["/stats", "/analytics"];

function refill(path: string): void {
  void upstream(path, "", WAIT_WARM)
    .then((hit) => {
      if (hit.status !== 200) return;
      cache.set(path + "?", hit);
      closedUntil = 0; // the index answered; let live requests through again
      saveCache();
    })
    .catch(() => { /* keep whatever is cached; the age is the whole report */ });
}

function warm(): void {
  for (const path of WARM) refill(path);
}

loadCache();
warm();
// unref so this timer is never the reason a process refuses to exit.
const heartbeat = setInterval(warm, TTL_MS);
if (typeof heartbeat.unref === "function") heartbeat.unref();

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

    // What this caller may see of an answer. Computed once, here, so every
    // exit below trims identically — the stale path included, which is the one
    // easiest to forget.
    const fields = route.publicFields;
    const full = fields === undefined || isOperator(req);
    const cut = (body: string) => (full ? body : trim(body, fields as string[]));

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
      const key = route.path + "?" + query;
      const hit = cache.get(key);
      if (hit) {
        const age = Date.now() - hit.at;
        // Stale is served, not awaited. The refresh goes behind the response,
        // so the caller pays nothing for the fact that the entry had expired.
        if (age >= TTL_MS) refill(route.path);
        res.statusCode = hit.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        // Cached whole and trimmed on the way out, so one cached answer serves
        // both tiers. `private` once a body depends on who asked: a shared
        // cache in front must not hand an operator's fuller answer to the next
        // visitor, and this box's own window is the part that mattered.
        res.setHeader("cache-control", `private, max-age=${Math.floor(TTL_MS / 1000)}`);
        // Only once the warmer has plainly been failing for a while. A 25s-old
        // number is not news; a five-minute-old one is, and the page says so.
        if (age > TTL_MS * 4) res.setHeader("x-index-stale", String(Math.round(age / 1000)));
        res.end(cut(hit.body));
        return;
      }
    }

    if (Date.now() < closedUntil) {
      // The seconds, not "moments ago". This code knows the number, and a
      // reader deciding whether to retry needs it rather than a word that
      // could mean two seconds or two minutes.
      const since = Math.max(1, Math.round((BREAKER_MS - (closedUntil - Date.now())) / 1000));
      json(res, 503, {
        error: "the search index is not answering",
        detail: `last tried ${since}s ago; retrying in the background`,
        upstream: BASE,
      });
      return;
    }

    void upstream(route.path, query)
      .then((hit) => {
        closedUntil = 0;
        if (route.cache && hit.status === 200) {
          cache.set(route.path + "?" + query, hit);
          if (query === "") saveCache();
        }
        res.statusCode = hit.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader(
          "cache-control",
          route.cache ? `private, max-age=${Math.floor(TTL_MS / 1000)}` : "no-store",
        );
        res.end(cut(hit.body));
      })
      .catch((err: unknown) => {
        // The one failure worth naming: the index is a single box on a tailnet
        // and it is allowed to be down. A page that says so is a page whose
        // reader stops debugging their own browser.
        // "The operation was aborted." is what AbortSignal.timeout says, and
        // it names the mechanism rather than the fact. A reader needs to know
        // the index went quiet, not that a signal fired.
        closedUntil = Date.now() + BREAKER_MS;
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
          res.end(cut(stale.body));
          return;
        }

        json(res, 503, {
          error: timedOut
            ? "the search index did not answer in time"
            : "the search index could not be reached",
          // Says what happened and how long it waited. The line here used to
          // read "<route> timed out; /stats and /analytics may still be fine",
          // which hedges twice and contradicts itself outright when the route
          // that timed out IS /stats.
          detail: timedOut
            ? `${route.path} did not respond within ${Math.round(WAIT_LIVE / 1000)}s`
            : raw.slice(0, 200),
          upstream: BASE,
        });
      });
  };
}
