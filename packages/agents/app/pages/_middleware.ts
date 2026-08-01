// Who the console thinks you are — one switch, read once, three answers.
//
//     AUTH=none      nobody is anybody. The community console, unchanged.
//     AUTH=builtin   this app holds the users and sets X-USER itself.
//     AUTH=proxy     something in front holds them and X-USER arrives.
//
// That is the whole of phase 4 (MIGRATION-LUMENJS.md). There is no fourth
// mode, no per-route override and no runtime toggle: the value is read at
// module load, an unrecognised one refuses to start, and every branch below
// hangs off the constant rather than off an environment lookup in a request
// path. A deployment's identity story should be answerable by reading one
// line of a unit file.
//
// --- what this file is not allowed to change ---------------------------------
//
// `src/api.ts` — `whoami()`, `isAdmin()`, the 401 → `/auth/login?returnTo=`
// redirect — is untouched by all three modes, and that is the test of whether
// this design is right rather than a nice property of it. The console asks
// `/whoami` and follows a 401; it never learns which mode it is running under.
// So each mode's job is to make those two seams true:
//
//   * `none`   answers neither. `/whoami` falls through to the engine, which
//              has no such route, and `!res.ok` is `null` — "no front door",
//              which is exactly what a community box is.
//   * `builtin` answers `/whoami` here, in the gateway's own document shape,
//              and 401s `/api` for a visitor with no session.
//   * `proxy`  answers neither, because the gateway already answered `/whoami`
//              before this process saw the request.
//
// If a change to this file needs a change to src/api.ts, the change is wrong.
//
// --- where this actually runs ------------------------------------------------
//
// Twice-registered, once-executed. LumenJS scans `pages/` for `_middleware.ts`
// and runs a page's chain — but it does so AFTER the global
// `lumenjs.server.js` chain, and `server/api-proxy.ts` is that global chain.
// Identity that arrives after the proxy has already forwarded the request is
// identity that arrives too late, so `lumenjs.server.js` imports `authChain`
// from here and puts it in front of the proxy itself. The default export
// stays, because a `pages/_middleware.ts` that is not a middleware module
// would be a trap for the next reader, and `handled()` below makes the second
// pass a no-op.

import os from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { setIdentityResolver } from "../server/identity.js";
import {
  handleAuth,
  readSession,
  xUserDocument,
  type AuthUser,
} from "../server/auth-builtin.js";

type Next = (err?: unknown) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

export type AuthMode = "none" | "builtin" | "proxy";

// --- the switch ---------------------------------------------------------------

/** Refuse to run rather than run half-configured.
 *
 *  `process.exit` and not `throw`, and the difference is the whole point:
 *  every place this module is loaded from swallows exceptions. LumenJS's
 *  middleware scanner logs "Failed to load _middleware.ts" and serves the
 *  request anyway; `loadUserServerMiddleware` warns and returns an empty
 *  array, which would start a console with no proxy and no guard at all. A
 *  throw here means the dangerous configuration runs with the check removed,
 *  which is the exact opposite of refusing.
 *
 *  In `lumenjs serve` this happens during startup, before the socket is
 *  listening, so it is literally a refusal to start. In `lumenjs dev` the
 *  module is loaded lazily on the first request, so it is a refusal to serve
 *  one — the earliest moment this code exists to say anything. */
function refuse(reason: string): never {
  console.error(`[auth] ${reason}`);
  process.exit(1);
}

function readMode(): AuthMode {
  const raw = (process.env.AUTH ?? "").trim().toLowerCase();
  if (raw === "" || raw === "none") return "none";
  if (raw === "builtin" || raw === "proxy") return raw;
  // Not a fallback to `none`. An operator who wrote `AUTH=oidc` believes this
  // console is authenticating somebody, and quietly serving it wide open
  // because the string was not recognised is how that belief survives.
  return refuse(
    `AUTH="${process.env.AUTH}" is not a mode. Use none, builtin or proxy.`,
  );
}

/** The mode, decided once. Exported so e2e and any future server code can
 *  branch on the same answer rather than re-reading the environment. */
export const AUTH: AuthMode = readMode();

// --- addresses -----------------------------------------------------------------

/** Whether an address is one only this machine or its own network can reach.
 *
 *  Loopback, RFC1918, RFC6598 carrier-grade NAT, link-local, and IPv6's
 *  unique-local and link-local ranges. Everything else is assumed reachable
 *  from the internet, which is the fail-closed direction: a range this does
 *  not recognise gets treated as public and the operator is told, rather than
 *  waved through because the parser was unimaginative. */
function isPrivateAddress(address: string): boolean {
  const a = address.replace(/^::ffff:/i, "").toLowerCase();
  if (a === "" || a === "::1" || a === "localhost") return true;
  if (/^127\./.test(a)) return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return true;
  if (/^f[cd]/.test(a)) return true;     // fc00::/7, unique local
  if (/^fe[89ab]/.test(a)) return true;  // fe80::/10, link local
  return false;
}

/** The address this process listens on.
 *
 *  It has to be resolved the same way twice, and the duplication is deliberate
 *  rather than unnoticed: `lumenjs.plugins.js` sets Vite's `server.host` from
 *  `AGENTS_CONSOLE_BIND` with the same default, and it cannot be imported from
 *  here — the dev server loads it with plain Node (`await import(pathToFileURL
 *  (...))`, no Vite in the path), so it is a `.js` that may not import a `.ts`,
 *  and this is a `.ts`. The two lines below and the `host:` line there are one
 *  fact written twice; change either and change both.
 *
 *  `AGENTS_CONSOLE_BIND` is honoured only under `lumenjs dev`, because that is
 *  the only place anything reads it: `build/serve.ts` calls `server.listen
 *  (port)` with no host at all and offers no way to say otherwise. So the
 *  wildcard is the truth for every other command, and an unrecognised one is
 *  treated as `serve` rather than as `dev` — this check is only worth having
 *  if its guesses err toward refusing. */
function boundTo(): string {
  const set = (process.env.AGENTS_CONSOLE_BIND ?? "").trim();
  if (set !== "") return set;
  return process.argv[2] === "dev" ? "127.0.0.1" : "0.0.0.0";
}

/** Every address this process could be reached on that is not private.
 *
 *  Two questions, and asking only the second one was a bug: what is this
 *  process bound to, and — if that is a wildcard — what can this machine be
 *  reached at. A bare `os.networkInterfaces()` sweep answers the second alone,
 *  so `AUTH=proxy` refused to start on any developer box with a public NIC
 *  even when `AGENTS_CONSOLE_BIND=127.0.0.1` had already made the console
 *  unreachable from anywhere. A guard that cannot be satisfied by doing the
 *  right thing teaches people to set the override, which is the one outcome
 *  worse than no guard.
 *
 *  Bound to one address, that address is the whole answer. Bound to a wildcard
 *  — which is `lumenjs serve`, always — the machine is what decides, and
 *  inside the shipped image that is a private container address and nothing
 *  else. So this stays quiet in the deployment it is written for, quiet on a
 *  laptop that bound loopback, and loud on a bare host answering the world. */
function publicAddresses(): string[] {
  const bind = boundTo();
  const wildcard = bind === "0.0.0.0" || bind === "::" || bind === "*" || bind === "true";
  if (!wildcard) return isPrivateAddress(bind) ? [] : [bind];

  const found: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue;
      if (!isPrivateAddress(entry.address)) found.push(entry.address);
    }
  }
  return found;
}

// --- the modes -----------------------------------------------------------------

/** The second pass, made harmless.
 *
 *  This chain is registered twice — see the header — so every middleware here
 *  runs once from `lumenjs.server.js` and once from the framework's own
 *  `pages/` scan. Everything below is close to idempotent anyway, but "close
 *  to" is not a property to rely on: a `Set-Cookie` written twice or a
 *  `readSession` paid for twice is a cost with no upside. */
const MARK = "__agentsConsoleAuthHandled__";
function handled(req: IncomingMessage): boolean {
  const seen = (req as any)[MARK] === true;
  (req as any)[MARK] = true;
  return seen;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    // An identity answer is not a thing to keep. /whoami is the console's
    // question about the current session, and a cached one outlives it.
    "cache-control": "no-store",
  });
  res.end(text);
}

// --- none ----------------------------------------------------------------------
//
// Nothing. Not a middleware that does nothing — no middleware at all, so the
// request reaches `server/api-proxy.ts` through exactly the code path it took
// before this file existed.
//
// It is worth saying what is deliberately absent: this does NOT strip an
// inbound `X-USER`. Stripping would feel tidier and it would be a behaviour
// change, and "today's community behaviour, bit for bit" is the requirement.
// The header is harmless because the engine ignores it — `AGENTS_TRUST_PROXY_
// AUTH` is off by default and `tagsFromHeader` does not read an untrusted
// header at all (packages/agents/owner.ts). An operator who turns that gate on
// while leaving AUTH=none has asked for a header-trusting engine on purpose,
// and this app is not the place that decision gets second-guessed.

// --- proxy ---------------------------------------------------------------------

/** `AUTH=proxy` — the inbound `X-USER` is the truth, and the bind had better
 *  be private.
 *
 *  Trusting a header means anyone who can open a TCP connection to this
 *  process can name themselves. That is a perfectly good arrangement behind a
 *  gateway that overwrites the header on every request (nuraly's does:
 *  `proxy_set_header X-USER $x_user`, from the verified token only) and an
 *  open door in front of one. The posture is the whole of the security, so it
 *  is checked rather than documented.
 *
 *  The boot check is in `guardProxyBind`. This is the backstop for the case
 *  the boot check cannot see: a connection that actually arrived on a public
 *  address. `localAddress` is the address the kernel accepted it on, so it is
 *  evidence rather than configuration — and refusing the request is right even
 *  though the boot check passed, because the boot check was wrong. */
const refuseWhenPubliclyReached: Middleware = (req, res, next) => {
  if (handled(req)) return next();
  const local = req.socket?.localAddress ?? "";
  if (local !== "" && !isPrivateAddress(local)) {
    console.error(
      `[auth] AUTH=proxy but this request arrived on ${local}, a public ` +
      "address. In this mode any client that reaches this port can name " +
      "itself with an X-USER header. Refusing.",
    );
    json(res, 500, { error: "console is publicly reachable in AUTH=proxy" });
    return;
  }
  next();
};

/** The boot half of the same rule.
 *
 *  There is an override because there has to be: a host with a public NIC and
 *  a firewall in front of this port is a legitimate deployment, and a check
 *  that cannot be satisfied gets deleted rather than satisfied. It is named to
 *  be embarrassing in a diff, and it does not disable
 *  `refuseWhenPubliclyReached` — an operator asserting a firewall still gets
 *  caught the moment a connection proves there is not one. */
function guardProxyBind(): void {
  const exposed = publicAddresses();
  if (exposed.length === 0) return;
  if (process.env.AUTH_PROXY_ALLOW_PUBLIC_BIND === "1") {
    console.warn(
      `[auth] AUTH=proxy on a host with public addresses (${exposed.join(", ")}). ` +
      "AUTH_PROXY_ALLOW_PUBLIC_BIND=1 is set, so this is your assertion that a " +
      "firewall keeps this port off them. Requests arriving on one are still refused.",
    );
    return;
  }
  refuse(
    `AUTH=proxy, but this console would answer on ${exposed.join(", ")} — bound ` +
    `to ${boundTo()}. This mode trusts the inbound X-USER header, so a public ` +
    "bind lets any caller name any owner. Set AGENTS_CONSOLE_BIND to a private " +
    "address (`lumenjs dev` reads it), publish the port to one (the compose file " +
    "does), or set AUTH_PROXY_ALLOW_PUBLIC_BIND=1 if a firewall already does it.",
  );
}

// --- builtin --------------------------------------------------------------------

/** Paths that never reach the engine and never need an identity: the dev
 *  server's own module graph and the Socket.IO transport. Reading a session
 *  for each of the several hundred module requests a cold page load makes
 *  would be decryption work for nobody's benefit.
 *
 *  Not an extension test. `/preview/<token>/index.html` has a dot and is an
 *  artifact asset that very much needs the header — which is the mistake the
 *  framework's own auth middleware makes (see server/auth-builtin.ts). */
function frameworkInternal(path: string): boolean {
  return path.startsWith("/@")
    || path.startsWith("/node_modules/")
    || path.startsWith("/socket.io/");
}

/** Whether refusing this request should look like a redirect to a person or a
 *  401 to a script.
 *
 *  A browser navigating to a page sends `Accept: text/html,...`; a module
 *  fetch, a loader call and every `fetch()` in src/api.ts do not. So this is
 *  the actual distinction rather than a guess from the path — which matters
 *  under `lumenjs dev`, where the login page's own source modules are served
 *  from paths that look nothing like assets. */
function isNavigation(req: IncomingMessage): boolean {
  return String(req.headers.accept ?? "").includes("text/html");
}

/** Requests the engine will be asked about, and which therefore must not go
 *  upstream without an identity. The prefixes are `server/api-proxy.ts`'s
 *  rules, minus `/whoami`, which is answered here. */
function reachesEngine(path: string): boolean {
  return path.startsWith("/api") || path.startsWith("/preview");
}

const builtinAuth: Middleware = (req, res, next) => {
  if (handled(req)) return next();
  const path = (req.url ?? "/").split("?")[0];

  if (frameworkInternal(path)) return next();

  // Never inherited, always derived. This mode's users reach the console
  // directly, so an inbound X-USER is a header the browser chose — deleting it
  // first means no path below can accidentally forward one.
  delete req.headers["x-user"];

  void (async () => {
    let user: AuthUser | null = null;
    try {
      user = await readSession(req);
    } catch (err) {
      // A session store that cannot be read is not "nobody is signed in" — it
      // is a console that cannot tell, and answering requests as an anonymous
      // caller would hand the unowned bucket to whoever asked. Fail closed.
      console.error("[auth] session unreadable:", (err as Error)?.message);
      json(res, 503, { error: "authentication is unavailable" });
      return;
    }

    // "Sign out" in the rail goes to `/logout` — src/sidebar.ts writes that
    // path, the gateway answers it in the deployment the rail was written for,
    // and this mode has no gateway. Aliased here rather than changed there,
    // for the same reason `/whoami` is answered here: the console's seams stay
    // deployment-agnostic and phase 4 keeps its promise not to edit src/.
    if (path === "/logout") {
      req.url = "/__nk_auth/logout" + (req.url ?? "").slice(path.length);
    }

    // Login, signup, logout and the rest. Before the guard, or signing in
    // would require being signed in.
    if ((req.url ?? "/").startsWith("/__nk_auth/")) {
      if (await handleAuth(req, res, user)) return;
      return next();
    }

    if (user) {
      // The console's own question, answered by the only party here that can.
      // It must not fall through to api-proxy.ts's `/whoami` rule: that
      // forwards to the engine, which has no such route and never learns what
      // a user is.
      if (path === "/whoami") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(xUserDocument(user));
        return;
      }
      // The one line the whole mode exists for.
      req.headers["x-user"] = xUserDocument(user);
      return next();
    }

    // Nobody is signed in.
    if (path === "/whoami" || reachesEngine(path)) {
      // 401 and not a redirect, because these are `fetch` calls: src/api.ts
      // turns a 401 into `/auth/login?returnTo=…` itself, which is the seam
      // phase 4 promised not to touch. Refusing rather than proxying
      // headerless is the security half — with the engine's trust gate on, a
      // request with no X-USER is the unowned tag, which is every row that
      // predates ownership.
      json(res, 401, { error: "not signed in" });
      return;
    }
    if (isNavigation(req) && !path.startsWith("/auth/")) {
      const here = req.url ?? "/";
      res.writeHead(302, {
        location: `/auth/login?returnTo=${encodeURIComponent(here)}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    next();
  })();
};

/** The socket's half of the same answer.
 *
 *  `server/sockets.ts` polls the engine with the browser's own credentials,
 *  and in this mode the browser has a cookie rather than a header — so the
 *  translation has to happen somewhere that can open a session, which is here
 *  and not in a module that gets bundled for the browser. See
 *  server/identity.ts for why the seam is shaped the way it is, and for what
 *  goes wrong without it.
 *
 *  Resolved per question rather than once per connection, deliberately: a
 *  socket may be open for a day, and "sign out everywhere" should stop its
 *  feed at the next tick rather than at the next reload. */
function installSocketIdentity(): void {
  setIdentityResolver(async (headers) => {
    // readSession reads nothing but `headers`; the cast says so rather than
    // pretending a handshake is a request.
    const user = await readSession({ headers } as unknown as IncomingMessage);
    return user ? xUserDocument(user) : "";
  });
}

// --- handing identity to the page ------------------------------------------------
//
// LumenJS already has the half of this that matters: `generateIndexHtml` writes
// `req.nkAuth.user` into a `__nk_auth__` script tag, and the router hydrates
// `@lumenjs/auth`'s store from it before the first render. So a component can
// ask `hasRole("admin")` synchronously, with the answer the server computed.
//
// The console could not use it before, for a reason that has nothing to do with
// this file: `req.nkAuth` is set by the framework's `auth` integration, which is
// off here (lumenjs.config.ts says why — it would mount behind the proxy chain
// and identify a request after it had already gone upstream). The integration is
// still off. What is new is that this middleware already knows the caller in
// every mode, so it can set the property the framework reads and leave the
// mounting question alone.
//
// What this replaces is a fetch. `src/api.ts` asked `/whoami` on boot and drew
// the rail from the answer, which meant a window where the page was rendered and
// the identity was not known — and `isAdmin` reads `null` as "community, show
// everything", so the admin menu was briefly offered to a logged-out visitor.
// That was a race, patched once by hand; injected identity removes the window
// rather than narrowing it.
//
// `null` stays meaningful and is passed through as such: no user in `AUTH=none`
// is not a signed-out user, it is a deployment where nobody signs in and the
// operator owns everything. The tri-state contract is unchanged.
function hydrateIdentity(read: (req: IncomingMessage) => Promise<unknown>): Middleware {
  return async (req, _res, next) => {
    try {
      const user = await read(req);
      if (user) { (req as unknown as { nkAuth?: unknown }).nkAuth = { user }; }
    } catch {
      // An identity that cannot be read is not an error to serve: the page
      // renders signed-out and the 401 on its first data call says the rest.
    }
    next();
  };
}

// --- the operator's tables are the operator's ------------------------------------
//
// The engine has no idea who is calling and is not going to grow one:
// EDITIONS.md is explicit that identity belongs to whatever sits in front, and
// GATEWAY.md's layering table says the same thing about these routes in
// particular — "configuration routes have NO engine-side authorisation, their
// only protection is the gateway's role check".
//
// On nuraly.io that role check is not there. The host serves ONE location,
// `location /agents/ { authenticateRequired() }`, and `server/api-proxy.ts`
// forwards every `/api/*` to the engine's root with no path or method
// allowlist — so authentication is the whole of it, and an ordinary signed-in
// user can `POST /agents/api/model-choices` or `PUT /agents/api/model-routers/
// rt-1`. That was survivable while the config tables only described the
// deployment. It stopped being survivable with the model menu: these rows are
// what every other user's composer offers and what their turns cost, and a
// choice inserted at rank 0 leads the menu for everybody.
//
// So the console, which is the only thing in this repo that stands in front of
// the engine on that host, refuses those writes itself. It is the same grain
// the gateway's own check has — a claim and a path, answerable from the request
// alone — and it is deliberately NOT a second identity system: it reads the
// identity this chain already established and nothing else.
//
// Reads are untouched. The composer's menu (`GET /models/choices`), the agent
// picker and the settings screens' own loads all have to work for everybody,
// and the engine decides what a read may show.
//
// This is a floor, not a replacement for the gateway's check. A caller who
// reaches `:8100` directly still bypasses everything, which is why
// "`:8100` must never be directly reachable" stays a launch gate.
const OPERATOR_PATHS = [
  "/api/models",
  "/api/model-configs",
  "/api/model-choices",
  "/api/model-routers",
  "/api/providers",
];

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

/** Whether this request would write one of the operator's tables. */
function writesConfiguration(req: IncomingMessage): boolean {
  if (READ_ONLY.has((req.method ?? "GET").toUpperCase())) return false;
  const path = (req.url ?? "/").split("?")[0];
  // A plain prefix, the way `server/api-proxy.ts` matches: `/api/models` claims
  // `/api/models/m1` and `/api/modelsFOO` alike. Claiming too much here refuses
  // a write; claiming too little lets one through, so the tie goes to refusing.
  return OPERATOR_PATHS.some((p) => path.startsWith(p));
}

/** Refuse a configuration write from somebody who is not an operator.
 *
 *  Installed only in the modes that HAVE identities. In `AUTH=none` there is
 *  one operator, they own the box, and there is nobody to distinguish them
 *  from — the same reading `isAdmin(null)` in `src/api.ts` already makes.
 *
 *  Absence of an identity in these modes is a refusal and not a pass: a request
 *  that arrives here with no session in `builtin`, or with no `X-USER` in
 *  `proxy`, is a request nobody authenticated. */
function guardConfigWrites(): Middleware {
  return (req, res, next) => {
    if (!writesConfiguration(req)) { next(); return; }
    const held = (req as unknown as { nkAuth?: { user?: { roles?: unknown } } }).nkAuth;
    const roles = held?.user?.roles;
    if (Array.isArray(roles) && roles.includes("admin")) { next(); return; }
    json(res, 403, {
      error: "changing models, the model menu or a provider key is an operator action",
    });
  };
}

// --- the chain -------------------------------------------------------------------

function build(): Middleware[] {
  if (AUTH === "none") return [];
  if (AUTH === "proxy") {
    guardProxyBind();
    // The gateway verified the token and stamped the header; parsing it here is
    // the whole of what this mode knows, and it is enough to hydrate the page.
    return [refuseWhenPubliclyReached, hydrateIdentity(async (req) => {
      const raw = req.headers["x-user"];
      const text = Array.isArray(raw) ? raw[0] : raw;
      if (!text) { return null; }
      try { return JSON.parse(text); } catch { return null; }
    }), guardConfigWrites()];
  }
  installSocketIdentity();
  return [builtinAuth, hydrateIdentity((req) => readSession(req)), guardConfigWrites()];
}

/** Imported by `lumenjs.server.js`, which places it ahead of the proxy. */
export const authChain: Middleware[] = build();

/** The LumenJS `pages/_middleware.ts` convention. Same array; `handled()`
 *  makes the duplicate registration cost nothing. */
export default authChain;
