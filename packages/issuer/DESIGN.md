# issuer — a standalone identity service, in Lumen

Design, 2026-07-30. Not built. The decision it implements: the agents
platform stops borrowing nuraly's login (lumenjs) and owns its front door —
as a **separate std-contrib package**, because an issuer is generic
infrastructure like `rest` or `plume`, not a feature of the agents engine.

## What it is, in one paragraph

A small Lumen HTTP service that owns users, passwords and roles, serves a
login page, and mints the HS256 JWT the OpenResty gateway already verifies.
It replaces the social-app proxying (`/__nk_auth/`, `/assets/`, `/@nuraly/`)
and the `SOCIAL_SESSION_SECRET` coupling — the coupling that produced the
nk-session/nk-access-token cookie mismatch and three gateway location blocks
whose only job is serving another app's build artifacts. The gateway and the
engine change almost nothing: the gateway swaps four proxy blocks for one,
the engine changes not at all.

    browser ── /auth/* ──► gateway ──► issuer :8110   (login page, tokens, users)
    browser ── /threads ─► gateway ──► engine :8100   (verifies cookie, stamps X-USER)
                              └─ verifies HS256 with ISSUER_JWT_SECRET

## Doctrine (inherited from EDITIONS.md, restated for this package)

- **The engine stays identity-blind.** The issuer is another thing in front
  of it, never a dependency of it. No import in either direction.
- **Community needs no issuer.** Authless community deployments simply do
  not run it. It is additive infrastructure, so it is **Apache-2.0** like
  the rest of std-contrib — an issuer anyone can use is the community story,
  and none of the agents product logic lives in it.
- **One thing.** Users, credentials, tokens, roles. No profiles, no avatars,
  no orgs, no email marketing. The moment it wants a second thing, that is
  the control plane's job.

## Two ways to consume — service and library, one package

The package must stay useful to someone who has never heard of the agents
platform. Both modes ship from day one and the split is structural, not
documented-only:

**1. Standalone service (the Keycloak posture).** `lumen compile api.ts`,
run the binary, put any reverse proxy in front. The integration contract is
deliberately tiny and proxy-agnostic:

- tokens are standard HS256 JWTs; any gateway that can do an HMAC verifies
  them — the OpenResty Lua here, a Caddy plugin, an Envoy filter, ten lines
  of anything. The README carries a verification recipe, not a client SDK.
- claims are fixed and boring: `sub, email, name, roles (always a JSON
  array), iat, exp`.
- the cookie name is config (`ISSUER_COOKIE_NAME`, default
  `nk-access-token` so this deployment needs no gateway change) — nothing
  `nk-` is hardcoded.
- every knob is env, none is code: port, cookie name, secret, signup
  on/off, TTLs.

**2. Imported directly.** The core modules — `hash.ts`, `token.ts`,
`sessions.ts`, `users.ts` — are plain Lumen with no HTTP, no env reads and
no cookie opinions, importable into any Lumen app that wants login without
running a second process. `api.ts` is a thin shell over them and doubles as
the reference embedding: everything it does goes through the same exported
functions an importer would call. The rule that keeps this honest: **if
api.ts needs a helper, the helper goes in a core module — api.ts owns only
HTTP shapes, cookies and env.** An `examples/embed.ts` shows the minimal
in-process use: verify a password, mint a token, check one.

## Storage

Own database (`issuer`), same Postgres instance, via plume. Never shares a
schema with the engine.

    users        id uuid, email unique, name, password_hash, roles jsonb,
                 created_at, disabled_at
    sessions     id (opaque 256-bit), user_id, created_at, expires_at,
                 revoked_at, user_agent   -- the refresh grant, one row per login
    resets       token_hash, user_id, expires_at, used_at
    audit        at, user_id, what (login/logout/reset/grant/revoke/disable),
                 detail

`roles` is the same JSON list nuraly uses (`["admin"]`), so the gateway's
`requireRole` and the console's `whoami` read identically.

## Passwords

Argon2id via `openssl kdf` — OpenSSL 3.4 on this host supports it, and
shelling to openssl through a 0700 temp dir is the pattern `agents/vertex.ts`
already uses for RS256, so it is proven Lumen. Parameters stored beside the
hash (`argon2id$v=..$m=..,t=..,p=..$salt$hash`) so they can be raised later
and re-hashed on next successful login. Verification is constant-time
comparison of the derived key.

Fallback if openssl is ever absent: refuse to start. A password service with
a weaker hash because the strong one was missing is not a fallback.

## Tokens — the revocation fix rides along

Two credentials, fixing the 24h-revocation gap the lumenjs design has:

1. **Access token**: HS256 JWT, claims `sub, email, name, roles, iat, exp`,
   TTL **15 minutes** (not 24h). Cookie `nk-access-token` — same name the
   gateway reads today, so the gateway Lua does not change. Also answered in
   the login response body for Bearer clients (scripts, mobile).
2. **Refresh token**: the opaque `sessions.id`, cookie `nk-refresh`,
   HttpOnly, `Path=/auth/refresh` so it is sent nowhere else, TTL 30 days,
   rotated on every use (the old row gets `revoked_at`; reuse of a revoked
   token revokes the whole session — standard theft detection).

`POST /auth/refresh` exchanges a live session for a fresh 15-minute access
token. Revoking a user (`disabled_at`, or session `revoked_at`) therefore
takes effect within 15 minutes, not at token expiry tomorrow. The console
needs one addition: on 401, try `/auth/refresh` once before redirecting to
login.

Signing key: `ISSUER_JWT_SECRET`, generated at first boot if unset, shared
with the gateway the same way `LUMENJS_JWT_SECRET` is today. (Migration
period: set it equal to the current secret and both issuers' tokens verify.)

## Routes

    GET  /auth/login          the login page (server-rendered, below)
    POST /auth/login          email+password → cookies + token in body; 429 via gateway zone
    POST /auth/logout         revoke the session, clear both cookies
    POST /auth/refresh        rotate refresh, mint access
    POST /auth/signup         optional — off unless ISSUER_SIGNUP=on
    POST /auth/forgot         always 202; writes resets row, prints the reset
                              URL to the log unless SMTP is configured
    POST /auth/reset          token + new password
    GET  /auth/me             the verified claims of the presented token

    -- admin (gateway gates these with requireRole("admin"), same as engine config)
    GET    /auth/users                    list
    PUT    /auth/users/:id/roles          grant/revoke — replaces psql surgery
    DELETE /auth/users/:id                disable (never row deletion; audit stays)

No TOTP in v1. It is the largest chunk of real work in an issuer, nobody is
asking yet, and the schema does not block adding a `totp` column later.

## The login page

Server-rendered HTML from the issuer itself — no SPA, no build step, no
`/assets/` chunks, which is exactly the class of 404 the social-app proxying
produced. One template, the console's design tokens inlined, dark/light via
`prefers-color-scheme`. `returnTo` is validated as a path (never a URL) —
the same open-redirect rule the console's own redirect follows.

## Gateway changes (small, deletions mostly)

- `/auth/` → `proxy_pass http://host.docker.internal:8110` — ONE block,
  keeping the existing `limit_req` zones on login/signup/forgot.
- Delete the social-app blocks from `agents.conf`: `/__nk_auth/`,
  `/assets/__nk_build_*`, `/@nuraly/`, and the login-chunk regexes.
- `/whoami` stays exactly as is — it reads X-USER, which reads the cookie,
  which the issuer now mints.
- Admin user routes: one `location /auth/users` with `requireRole("admin")`.

## Migration from lumenjs

One script, one run: copy `_nk_auth_users` (id, email, name, roles) into
`users`. Password hashes are lumenjs bcrypt — do NOT try to convert; store
as `bcrypt$...` and verify bcrypt on login, re-hash to argon2id on first
success. Sessions start empty; everyone logs in once. The engine's `owner`
tags are the same uuids, so nothing in the agents DB moves.

## Testing (the scenario doctrine)

Committed scripts beside the package, runnable against a throwaway instance:
signup/login/refresh/logout lifecycle; wrong password 401 and audit row;
refresh rotation and theft detection (reuse → whole session dead); disabled
user 401 within one access-TTL; reset flow end to end; bcrypt→argon2id
upgrade on first login; `roles` array shape (the cjson `{}` lesson); and the
gateway e2e matrix re-run unchanged — it must not notice the issuer swap.

## Size estimate

~2 days: day one storage+hashing+tokens+routes, day two login page,
migration script, tests, gateway swap. The risk concentrates in exactly two
places — argon2 parameters and refresh rotation — and both have committed
tests before anything fronts them.

## Out, with reasons

- TOTP/MFA (add when asked; schema ready)
- OIDC/social login (that is Keycloak territory — revisit at real SSO)
- email sending (log the reset URL; SMTP is config, not code)
- orgs/teams/sharing (control plane)
- rate limiting in the issuer (the gateway already owns it)
