# Executive plan — hosted agents service on nuraly auth

**Goal.** Expose the agents engine as a multi-user hosted service behind the
nuraly gateway, while the community edition stays one untouched binary.

**Decisions locked.** Nuraly's existing HS256 JWT, no Keycloak. Identity
lives in the gateway (BFF); the engine sees one opaque owner tag, gated off
by default. Same binary both editions; separation by repo, not by flag.
AGPL engine + Apache std-contrib; dual licensing on sole ownership.
Full detail: `GATEWAY.md`, `EDITIONS.md`, `LICENSING.md`.

---

## Phase 0 — Stop the bleeding (½ day) — do regardless of the rest

| # | Item | Why now |
|---|------|---------|
| 0.1 | Rotate placeholder `JWT_SECRET`; define missing `LUMENJS_JWT_SECRET` (compose passes empty → nuraly auth silently no-ops today); deploy-time check against placeholder/empty | live prod hole |
| 0.2 | Rotate the GitHub PAT embedded in std-contrib's git remote | leaked credential |
| 0.3 | Nothing to fix: there is no sweep today. If one is ever wanted it is `AGENTS_SWEEP_IDLE_MS`, off by default, off the request path, and it spares threads holding a file or a run | a request-path sweep under scoping deletes other tenants' rows |
| 0.4 | Firewall `:8100` (allow Docker bridge 172.16.0.0/12 first); verify no external answer | engine is open on 0.0.0.0, ufw inactive |

## Phase 1 — Engine: owner scoping (1½ days)

- `AGENTS_TRUST_PROXY_AUTH` env gate, off by default → community bit-for-bit unchanged
- Migration 71 via frozen `threadsMappingV1` (checksum trap); `owner TEXT NOT NULL DEFAULT ''`, index `(owner, created_at)`
- Shared `ownedThread()` resolver (tag-list signature) into ~16 routes; wrong tag → 404; list filter in SQL
- Runs: add `thread_id` + `owner` + token columns; guard `GET /runs/:id`
- Cutover rule: header present → only `owner = tag`; one-time backfill script

## Phase 2 — Engine: caps + usage (1 day)

- Consts → env (`AGENTS_UPLOAD_BYTES_MAX`, artifact/thread caps); add the missing workspace-door byte cap
- `AGENTS_API_TOKEN` optional bearer lock (defense-in-depth behind the firewall)
- `GET /healthz`; `GET /usage?owner=` (bytes + persisted tokens)

## Auth topology (decided 2026-07-29)

Console lives at **`lumen-agents.the-agent.dev`** — a different registrable
domain from nuraly, and nuraly's session cookie is host-only
(`session.ts:44`, no `Domain=`), so it can never ride there. Decision: the
agents host **serves its own login by proxying nuraly's existing auth
endpoints** (`/__nk_auth/*`, `/auth/login|signup|forgot-password|
reset-password`) under its own hostname. Same social app, same user table,
same JWT secret, same `limit_req` zones — the cookie simply lands host-only
on `the-agent.dev`. No duplicated password/TOTP/reset code.

"The cookie simply lands host-only" was half true. The cookie a login wrote
was `nk-session`, an encrypted blob only the social app can open, and the
gateway reads `nk-access-token`, an HMAC JWT — so login succeeded and every
request after it was 401. Cookie-mode login/signup/TOTP/OIDC-callback now
set both and logout clears both, and `LUMENJS_JWT_SECRET` must equal
`SOCIAL_SESSION_SECRET` because that is what signs it.

Tunnel change: `lumen-agents.the-agent.dev` currently points straight at the
console's dev server (`127.0.0.1:5173`); it must point at the gateway
(`127.0.0.1:8090`),
which gets a `server_name lumen-agents.the-agent.dev` block. With a
dedicated host there is no `/agents/` prefix and no prefix stripping — paths
map 1:1 to the engine. `lumen-artifacts.the-agent.dev` stays a separate
origin (the AGENTS_PREVIEW_HOST separation) and keeps its own rules. The
console then has to be reachable *from a container*: it binds loopback by
default, and `host.docker.internal` is never loopback, so
`AGENTS_CONSOLE_BIND` moves it to the bridge and the firewall script closes
`:5173` to everything else.

Endgame noted: if the console later replaces `nuraly.io`, owning a login
surface from day one makes that a DNS change, not a re-architecture.

## Phase 3 — Gateway (1½ days, nuraly repo)

- `authenticateRequired()`: fail-closed, 401, fail-closed Origin check, preflights terminated at gateway
- Static `proxy_pass http://host.docker.internal:8100/` + `extra_hosts` (NOT the map pattern — 502s)
- Locations: `=/agents/threads`, `/agents/threads/`, `/agents/preview/`, `=/agents/agents` (GET), `=/agents/healthz` public, `/agents/` admin-role; X-USER always overwritten; 3600s read timeout on threads (long POSTs, no SSE exists)
- Console through the gateway host — cookie rides, zero token code in `app/`

## Phase 4 — E2e + launch (1 day)

- Committed scripts in nuraly repo: 401 matrix, forged X-USER → 401 (CI gate on `backend.conf` diffs) plus the same header reaching a passthrough upstream as nothing, the real browser cookie admitted and an `nk-session` blob refused, two-tag isolation across threads/artifacts/files/runs/search, trust-gate-off ignores header, >60s POST, non-admin preview
- Launch checklist = Phase 0 all green + e2e green

**Total: ~5 days.**

## Parallel track — licensing (no code, clock is ticking)

1. Grant-style CLA (not assignment) + SPDX headers **before first external PR** — one outside patch without it kills dual licensing
2. Extract `packages/agents` to its own repo (GitHub badges the monorepo Apache; moves ops-adjacent docs out of public tree)

## Deferred (triggers, not dates)

- Second paying customer → control plane, provisioning, quotas, billing (private repo)
- Sharing request → tag-set guard (resolver already takes a list)
- Real SSO / per-tenant realms → Keycloak/OIDC at the gateway
- Self-hosters appear → one-command compose
- `LUMEN_BIND` in the language → drop firewall-only posture

## Top risks

| Risk | Mitigation |
|------|------------|
| `:8100` reachable + trust gate on = free impersonation | firewall + `AGENTS_API_TOKEN` + post-deploy probe (0.4, 2) |
| Future edit wires `/agents/` to fail-open `authenticatePassthrough` | forged-X-USER e2e as required CI gate |
| Migration 71 bricks existing DBs | frozen-mapping pattern, tested on a copy of prod DB first |
| Legacy `''` threads leak at cutover | only-exact-tag filter + explicit backfill |
