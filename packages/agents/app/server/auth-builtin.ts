// `AUTH=builtin`: the console keeping its own users.
//
// One mode of the three in pages/_middleware.ts, and the only one with any
// machinery behind it. `none` does nothing and `proxy` copies a header; this
// is sessions, a password table and a database, so it lives here and the
// dispatch stays readable.
//
// Everything that decides anything is LumenJS's — `handleAuthRoutes` answers
// `/__nk_auth/*`, `native-auth.js` hashes and checks passwords,
// `session.js` seals and opens the cookie. Nothing here reimplements a
// security primitive. What this file owns is four joins the framework does
// not make for us, each with a reason it cannot:
//
//   1. The auth integration is OFF, deliberately, so the framework's own auth
//      middleware never runs. See "why not the integration" below.
//   2. The database is opened here rather than by the auth plugin, and it is
//      THIS APP'S database — never the engine's. The engine is another
//      process behind AGENTS_API and its schema is not ours to put a users
//      table in; phase 4's whole shape depends on that staying true.
//   3. `ensureUsersTable` emits Postgres DDL. On SQLite it is a syntax error,
//      so the one dialect difference is translated here — see `sqliteDialect`.
//   4. The `X-USER` document has to come out byte-compatible with the
//      gateway's, or the engine and the console would be looking at two
//      different identities. See `xUserDocument`.
//
// --- why not the integration -------------------------------------------------
//
// `integrations: ['auth']` in lumenjs.config.ts would mount all of this for
// free, and it cannot be used, for a reason that is structural rather than a
// preference:
//
// The framework registers its auth session middleware AFTER the global
// `lumenjs.server.js` chain — `dev-server/server.ts` puts `authPlugins.pre`
// after `userServerMiddlewarePlugin`, and `build/serve.ts` runs the global
// chain at line ~250 and the auth middleware after it. `server/api-proxy.ts`
// IS that global chain. So by the time `req.nkAuth` existed, the `/api`
// request it describes has already been sent upstream with no `X-USER` on it.
// The identity has to be resolved before the proxy, and the only place that
// runs before the proxy is the proxy's own chain.
//
// Two smaller things fall out the same way and are worth knowing before anyone
// tries to switch it back on:
//
//   * `readProjectConfig` scrapes `integrations` out of lumenjs.config.ts with
//     a regular expression, not by evaluating the module, so the list cannot
//     be conditional on `AUTH` at all. On would mean on in all three modes.
//   * The framework's session middleware skips any path containing a `.`,
//     which is every artifact asset under `/preview/`. Skipped means no
//     identity, and in this mode no identity means 401 — a signed-in user's
//     artifacts would fail to load. `readSession` below deliberately has no
//     such skip; that difference is the point, not an oversight.
//
// It should be reported upstream as "the auth middleware cannot be composed
// ahead of user middleware", and it is the concrete shape of MIGRATION-
// LUMENJS.md's risk 1. Nothing here patches the framework.

import type { IncomingMessage, ServerResponse } from "node:http";

// LumenJS's auth internals, by deep path. The package publishes no `exports`
// map, so `dist/` is reachable — this is how apps/social reaches
// `dist/storage/index.js` too. Imported dynamically, all of it: this module is
// only ever loaded in `builtin`, but `pages/_middleware.ts` imports it
// statically to keep the dispatch legible, and `db/index.js` pulls in
// `better-sqlite3` at the top of the file (MIGRATION-LUMENJS.md, finding 1).
// Keeping every one of these behind `start()` means `none` and `proxy` never
// load a database driver they will not open.

/** The framework's user, as far as anything here cares. */
export interface AuthUser {
  sub: string;
  email?: string;
  name?: string;
  roles: string[];
  [key: string]: unknown;
}

interface Booted {
  /** A `ResolvedAuthConfig`, kept loose so this file does not import the
   *  framework's types at module scope. */
  config: any;
  db: any;
}

// --- configuration -----------------------------------------------------------

/** The secret that seals the session cookie and signs the edge JWT.
 *
 *  There is no default in production, and that is not caution for its own
 *  sake: the cookie is authenticated encryption, so a known secret is a
 *  forged session for any user, including one with the admin role. A
 *  development fallback exists because a console that will not start on a
 *  laptop gets its guard removed rather than its secret set — the same
 *  bargain apps/social makes, and it is loud in the log. */
function sessionSecret(): string {
  const set = (process.env.AUTH_SESSION_SECRET ?? "").trim();
  if (set !== "") return set;
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[auth] AUTH=builtin needs AUTH_SESSION_SECRET. Refusing to start: " +
      "without it every session cookie on this box is forgeable.",
    );
    process.exit(1);
  }
  console.warn(
    "[auth] AUTH_SESSION_SECRET is unset — using the development secret. " +
    "Sessions on this server are forgeable by anyone who has read this line.",
  );
  return "agents-console-dev-only-secret";
}

/** Everything `handleAuthRoutes` and the session reader need, spelled out.
 *
 *  The framework would build this from a `lumenjs.auth.ts` at the project
 *  root, and there deliberately is none: that file is only read by the auth
 *  integration, which is off (above), so a config sitting there would look
 *  like it configured something and configure nothing. The route paths below
 *  are `auth/config.ts`'s `ROUTE_DEFAULTS` verbatim — pages/auth/*.ts posts to
 *  them, and the two lists have to agree. */
function authConfig(): any {
  const secure =
    process.env.NODE_ENV === "production" &&
    process.env.INSECURE_SESSION_COOKIE !== "1";

  return {
    providers: [{
      type: "native",
      name: "local",
      minPasswordLength: 8,
      // A console is not a public sign-up. Registration is how the first
      // account gets made on a team box, so it is on by default and one env
      // closes it once the team exists.
      allowRegistration: process.env.AUTH_ALLOW_SIGNUP !== "0",
      // No mailer is wired in this app, and requiring a verification email
      // nobody can send locks out every account ever created.
      requireEmailVerification: false,
    }],
    session: {
      secret: sessionSecret(),
      cookieName: "nk-session",
      maxAge: 60 * 60 * 24 * 7,
      secure,
    },
    routes: {
      login: "/__nk_auth/login",
      loginPage: "/auth/login",
      callback: "/__nk_auth/callback",
      logout: "/__nk_auth/logout",
      signup: "/__nk_auth/signup",
      postLogin: "/",
      postLogout: "/auth/login",
    },
    guards: { defaultAuth: false },
    permissions: { enabled: false, defaultOwnerGrants: [] },
    // Bearer tokens are a second credential with a second lifetime and no way
    // to revoke one from the console. The browser has a cookie; a script in
    // this mode can log in and keep the cookie too.
    token: { enabled: false, accessTokenTTL: 900, refreshTokenTTL: 604800 },
  };
}

// --- the database ------------------------------------------------------------

/** `ensureUsersTable` writes `created_at TEXT NOT NULL DEFAULT NOW()`, which
 *  SQLite cannot parse — `near "(": syntax error`, thrown before the table
 *  exists, on the first signup and on every one after. It is Postgres DDL in
 *  a code path that runs under both.
 *
 *  Translated rather than copied. Keeping our own `CREATE TABLE` beside
 *  upstream's would mean two schemas drifting apart the first time a column is
 *  added there — and columns have been added there four times already, judging
 *  by the `ALTER TABLE` chain in the same function. Rewriting the one
 *  dialect-specific token leaves the schema upstream's.
 *
 *  A Proxy and not a spread: `LumenDb` is a class, so its methods live on the
 *  prototype and `{...db}` would hand `handleAuthRoutes` an object with no
 *  `get` and no `run`. */
function sqliteDialect(db: any): any {
  const NOW = /DEFAULT\s+NOW\(\)/gi;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "exec") {
        return (sql: string) => target.exec(String(sql).replace(NOW, "DEFAULT (datetime('now'))"));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

let booting: Promise<Booted> | null = null;

/** Opened once, on the first request that needs it. */
export function builtin(): Promise<Booted> {
  return (booting ??= start());
}

async function start(): Promise<Booted> {
  const { setProjectDir } = await import("@nuraly/lumenjs/dist/db/context.js");
  // The framework sets this from its own `projectDir`, but only inside the
  // auth plugin, which is off. `lumenjs dev` and `lumenjs serve` are both run
  // from the app directory, and `LUMENJS_PROJECT_DIR` is the escape hatch the
  // framework itself reads in its Postgres path.
  setProjectDir(process.env.LUMENJS_PROJECT_DIR ?? process.cwd());

  const { useDb } = await import("@nuraly/lumenjs/dist/db/index.js");
  const opened = useDb();
  // `DATABASE_URL` picks Postgres, which the community compose already runs
  // for the engine — a second database on the same server, never the engine's
  // own. Unset, it is `data/db.sqlite` under this app (see lumenjs.config.ts),
  // which is the laptop case.
  const db = opened.isPg ? opened : sqliteDialect(opened);

  const { ensureUsersTable } = await import("@nuraly/lumenjs/dist/auth/native-auth.js");
  await ensureUsersTable(db);

  return { config: authConfig(), db };
}

// --- reading the session -----------------------------------------------------

/** Who this request is, or `null`.
 *
 *  The order is `auth/middleware.ts`'s, on purpose — Bearer, then the raw
 *  access-token cookie, then the encrypted session — so a client that works
 *  against a LumenJS app works against this one. What is deliberately absent
 *  is that middleware's `url.includes('.')` skip: see the note at the top of
 *  the file, and do not add it back. */
export async function readSession(req: IncomingMessage): Promise<AuthUser | null> {
  const { config, db } = await builtin();
  const secret = config.session.secret as string;

  const bearer = req.headers.authorization;
  if (typeof bearer === "string" && bearer.startsWith("Bearer ")) {
    const { verifyAccessToken } = await import("@nuraly/lumenjs/dist/auth/token.js");
    try {
      const user = verifyAccessToken(bearer.slice(7), secret);
      if (user) return user as AuthUser;
    } catch { /* not a token we issued — try the cookies */ }
  }

  const cookie = req.headers.cookie;
  if (typeof cookie !== "string" || cookie === "") return null;

  const edge = cookie.match(/(?:^|;\s*)nk-access-token=([^;]+)/);
  if (edge?.[1]) {
    const { verifyAccessToken } = await import("@nuraly/lumenjs/dist/auth/token.js");
    try {
      const user = verifyAccessToken(decodeURIComponent(edge[1]), secret);
      if (user) return user as AuthUser;
    } catch { /* fall through to the sealed session */ }
  }

  const session = await import("@nuraly/lumenjs/dist/auth/session.js");
  const sealed = session.parseSessionCookie(cookie, config.session.cookieName);
  if (!sealed) return null;
  const opened = await session.decryptSession(sealed, secret);
  if (!opened?.user) return null;

  // "Sign out everywhere" is a column on the user row, not a list of live
  // sessions, so a cookie stays cryptographically valid after it. Fails
  // CLOSED: a database this cannot read is a session this cannot vouch for,
  // which is upstream's choice too.
  if (opened.createdAt && opened.user.sub) {
    try {
      const { getSessionsRevokedAt } = await import("@nuraly/lumenjs/dist/auth/native-auth.js");
      const revoked = await getSessionsRevokedAt(db, opened.user.sub);
      if (revoked && opened.createdAt <= revoked) return null;
    } catch {
      return null;
    }
  }

  return opened.user as AuthUser;
}

// --- the identity document ---------------------------------------------------

/** Emails that hold the admin role, from the environment.
 *
 *  `registerUser` gives every account `roles: []`, and there is no screen in
 *  this console for editing them — so without this, a `builtin` deployment is
 *  one where `isAdmin()` is false for everybody and every configuration menu
 *  is hidden from the person who installed it.
 *
 *  It is cosmetic and must stay cosmetic. `isAdmin()` in src/api.ts hides
 *  menus; the refusal that matters is the gateway's `requireRole`, which does
 *  not exist in this mode because there is no gateway — a `builtin` box is one
 *  where everyone who can sign in can reach the whole engine. Say so in the
 *  compose file rather than pretending this line is a permission system. */
function adminEmails(): Set<string> {
  return new Set(
    (process.env.AUTH_BUILTIN_ADMINS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
}

/** Non-ASCII, escaped to `\uXXXX`.
 *
 *  This string becomes an HTTP header value. Node rejects a header containing
 *  a code point above 255 outright (`ERR_INVALID_CHAR`), so a user called
 *  `José` would not get a scoped request — they would get a proxy that throws
 *  on every call, which reads as "the console is broken", not "the name has an
 *  accent". `\uXXXX` is JSON's own escape, so the engine's parser sees the
 *  same string it would have seen. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** The `X-USER` document for a signed-in user.
 *
 *  Byte-compatible with what the gateway's `lumenjs-auth.lua::to_x_user`
 *  builds, and it has to be: the engine reads `uuid` out of it
 *  (`owner.ts::tagsFromHeader`) and the console reads the whole thing back
 *  through `/whoami` (`src/api.ts::Me`). Two producers of one document is
 *  already one too many; two producers disagreeing about a field name is a
 *  conversation that belongs to nobody.
 *
 *  Field for field, against the Lua:
 *    uuid      = payload.sub          — the stable id, never the email
 *    username  = email or name or sub
 *    email     = payload.email        — absent when the user has none, because
 *                                       cjson omits a nil and so does
 *                                       JSON.stringify on undefined
 *    anonymous = false
 *    roles     = a real array, empty array included — the gateway comment
 *                explains why (`ipairs`), and `Me.roles` in src/api.ts is
 *                typed as one
 *
 *  `last_name` is in the Lua's table and is always nil there, so cjson never
 *  emits it; it is absent here for the same reason and not by oversight. */
export function xUserDocument(user: AuthUser): string {
  const roles = Array.isArray(user.roles) ? [...user.roles] : [];
  const email = typeof user.email === "string" ? user.email : undefined;
  if (email && adminEmails().has(email.toLowerCase()) && !roles.includes("admin")) {
    roles.push("admin");
  }
  return asciiJson({
    uuid: user.sub,
    username: email ?? (typeof user.name === "string" ? user.name : undefined) ?? user.sub,
    email,
    anonymous: false,
    roles,
  });
}

// --- the framework's own routes ----------------------------------------------

/** `/__nk_auth/*` — login, signup, logout, and the rest of the set.
 *
 *  Answers `true` when it took the request. `req.nkAuth` is set first because
 *  `/__nk_auth/me` and the change-password route read it, and nothing else
 *  sets it in this app. */
export async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  user: AuthUser | null,
): Promise<boolean> {
  const { config, db } = await builtin();
  (req as any).nkAuth = user ? { user } : null;
  const { handleAuthRoutes } = await import("@nuraly/lumenjs/dist/auth/routes.js");
  return handleAuthRoutes(config, req, res, db);
}
