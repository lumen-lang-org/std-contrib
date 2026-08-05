// The proxy table, as Connect middleware.
//
// This is the only copy of the proxy table, and it is the one place these
// three rules live. It began as vite.config.ts's `server.proxy` reimplemented
// against LumenJS's server, which has no proxy option of its own; the rules
// and the comments explaining them were carried over word for word, because
// two of them record production bugs and a comment that drifts from the code
// it explains is how a fixed bug comes back. Phase 5 removed the Vite server
// and nginx.conf, which each held a second copy — so there is nothing left to
// keep this in step with, and nowhere else to change a rule by accident.
//
// One origin in every environment: the dev server proxies /api to the Lumen
// agents API exactly the way nginx does in the compose file, so CORS never
// exists as a problem to solve.
//
// One thing here is not a proxy rule at all: a successful write calls
// noteWrite() so the socket pollers hear about it at once instead of on their
// next tick. No request is routed, rewritten or answered differently because
// of it — what goes upstream and what comes back are byte-identical either
// way.

import http from "node:http";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
// The address and the path-prefix rule moved out so the socket poller can use
// the same ones — see server/engine.ts. Only the resolution moved; every rule
// below is where it was.
import { engineTarget as target, stripTrailingSlash } from "./engine.js";
// The one thing this file does besides proxying: say when a write went
// through, so the socket pollers stop discovering it on a timer. It changes no
// rule below and forwards no data — see server/nudge.ts for why a bare signal
// is the only shape this may take.
import { noteStream, noteWrite } from "./nudge.js";

type Next = (err?: unknown) => void;
type Middleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: Next,
) => void;

interface Rule {
  /** Matched against the request path the way Vite matches a proxy key: a
   *  plain prefix, not a route. `/api` claims `/api`, `/api/threads` and
   *  `/apiary` alike — which is Vite's behaviour, so it is this one's. */
  prefix: string;
  rewrite?: (path: string) => string;
}

const RULES: Rule[] = [
  // Previews are served by the API at its own root, not under /api: the
  // URL a page's relative links resolve against has to be the artifact's
  // own path, so it cannot carry a prefix belonging to the console.
  { prefix: "/preview" },

  // Not an engine route: the gateway answers this one itself, because it
  // is the only party that knows who the caller is. Unproxied, the dev
  // server answers it with the SPA's own HTML — which parses as no answer
  // at all, which the console reads as "nothing authenticates here" and
  // then offers every admin tool to everybody.
  { prefix: "/whoami" },

  {
    prefix: "/api",
    rewrite: (path) => path.replace(/^\/api/, ""),
  },
];

// Methods that cannot have changed anything, so cannot be worth waking a
// poller for. Everything else is treated as a write, including the ones this
// API does not use: a method list is a thing that grows, and guessing low
// costs a socket its latency while guessing high costs it one loopback query.
const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether this request, if the engine accepts it, can change what another
 *  browser's sidebar should show.
 *
 *  Only `/api` — the other two rules do not reach the engine's state at all:
 *  `/preview` is the artifacts host answering GETs for a page's own assets,
 *  and `/whoami` is the gateway describing the caller. */
function writes(rule: Rule, method: string | undefined): boolean {
  return rule.prefix === "/api" && !READ_ONLY.has((method ?? "GET").toUpperCase());
}

function match(url: string): Rule | null {
  const path = url.split("?")[0];
  for (const rule of RULES) {
    if (path.startsWith(rule.prefix)) return rule;
  }
  return null;
}

/** The engine saying a streamed chunk landed — see server/nudge.ts.
 *
 *  Answered here, ahead of every proxy rule, because it must never go
 *  upstream: the engine is the caller. Refused unless it arrived DIRECTLY
 *  from a private address — a request that came through the gateway carries
 *  X-Forwarded-For, and a public caller allowed to fire this at will could
 *  make every socket poll on their schedule. The signal carries nothing, so
 *  there is nothing else to check. */
function engineNudge(req: IncomingMessage, res: ServerResponse): boolean {
  if ((req.url ?? "").split("?")[0] !== "/__engine_nudge") return false;
  const fwd = req.headers["x-forwarded-for"];
  const from = req.socket?.remoteAddress ?? "";
  const direct = fwd === undefined
    && (/^(::ffff:)?(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(from) || from === "::1");
  res.writeHead(direct ? 204 : 403, { "content-length": "0" });
  res.end();
  if (direct) noteStream();
  return true;
}

export function apiProxy(): Middleware {
  return (req, res, next) => {
    if (engineNudge(req, res)) return;
    const url = req.url ?? "/";
    const rule = match(url);
    if (!rule) return next();

    const upstream = target();
    const [path, query] = splitQuery(url);
    const rewritten = rule.rewrite ? rule.rewrite(path) : path;

    // Keep the browser's Host. `changeOrigin: true` rewrites it to the
    // target, which is the same hole nginx had: the preview route decides
    // its content type from that header, and a rewritten one is a decision
    // made about a host nobody asked for.
    //
    // Under http-proxy that was one flag; here it is the absence of a line.
    // `req.headers` goes upstream untouched, and this comment is the only
    // thing standing between the next reader and "helpfully" setting host.
    const headers = { ...req.headers };

    const agent = upstream.protocol === "https:" ? https : http;
    const proxied = agent.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        method: req.method,
        path: joinQuery(stripTrailingSlash(upstream.pathname) + rewritten, query),
        headers,
      },
      (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        // The engine has committed and started answering, which is the
        // earliest instant a poller asking again would see the change — and
        // the exact instant e2e/live-fanout.spec.ts starts its clock. Before
        // the pipe, so the feed is already moving while the body is still on
        // its way back to the browser that caused it.
        //
        // Only on success. A refused write changed nothing, and a 401 in
        // particular must not become a way to make every socket on the server
        // ask the engine a question.
        if (status >= 200 && status < 300 && writes(rule, req.method)) noteWrite();
        res.writeHead(status, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    // A dead API is a 502 from this server, not an unhandled error that takes
    // the dev server down with it. The console's own fetch error paths then
    // report it the way they report any other failing call.
    proxied.on("error", (err: NodeJS.ErrnoException) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`Agents API unreachable at ${upstream.origin}: ${err.message}\n`);
    });

    req.on("aborted", () => proxied.destroy());
    req.pipe(proxied);
  };
}

function splitQuery(url: string): [string, string] {
  const i = url.indexOf("?");
  return i === -1 ? [url, ""] : [url.slice(0, i), url.slice(i)];
}

function joinQuery(path: string, query: string): string {
  return (path === "" ? "/" : path) + query;
}

export default [apiProxy()];
