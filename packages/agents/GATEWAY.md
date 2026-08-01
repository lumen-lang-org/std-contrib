# Agents behind the nuraly gateway — the plan

Decision (2026-07-29): identity is nuraly's existing LumenJS JWT
(HS256 over `LUMENJS_JWT_SECRET`), validated where it is already validated —
in the OpenResty gateway (`nuraly/services/gateway`). No Keycloak, no new
identity infrastructure. The engine stays identity-blind per `EDITIONS.md`:
what "activates" the hosted edition is this gateway in front, not a flag.

Reviewed 2026-07-29 by five independent passes (security, data model,
nginx/OpenResty, product/licensing, implementation). Verdict: architecture
sound; the original draft had two config mechanics that would fail on first
request, three "already there" claims that were half-true, and unmet
preconditions. All folded in below. Honest estimate: **4–5 days**, not the
half-day first quoted.

    browser ──(nk-access-token cookie)──► gateway :8090 ──► host :8100 ./api
    scripts ──(Authorization: Bearer)──►     │
                                             └── 401 when neither verifies

HS256 with one shared secret is acceptable here: only the issuer and the
gateway ever hold it, the engine never touches it. The weak point is secret
lifecycle, not the algorithm — see preconditions.

## Gateway changes (`nuraly/services/gateway/Nginx/`)

1. **`lua-lib/main.lua` — `authenticateRequired()`.** `checkOrigin()`, then
   `tryLumenJSAuth()`; on failure 401 JSON + `ngx.exit(401)`. Never falls
   through, never trusts inbound `X-USER`. For `/agents/` locations the
   Origin check must **fail closed**: non-GET with `ALLOWED_ORIGINS` unset
   → 403 (the existing `checkOrigin` warns and allows; cookie auth makes
   that a CSRF hole). OPTIONS: terminate preflights at the gateway
   (`return 204` + CORS headers inside the location) — do not proxy them
   unauthenticated.

2. **Upstream: static `proxy_pass`, not the map pattern.** The gateway's
   `resolver 127.0.0.11` never reads `/etc/hosts`, so a `map` +
   variable-proxy_pass to `host.docker.internal` 502s at request time.
   Correct form:

       location /agents/ {
           proxy_pass http://host.docker.internal:8100/;
       }

   Static hostnames resolve at startup via glibc, which does read the
   `extra_hosts: ["host.docker.internal:host-gateway"]` entry (add to the
   gateway service in `docker-compose.prod.yml`). This also does the
   `/agents/` → `/` prefix replacement correctly for free. Do NOT copy the
   existing `/api/v1/functions` block — its variable-with-URI form truncates
   every subpath.

3. **Locations.** More-specific user locations above the role-gated rest:

       location = /agents/threads     { user }   # exact, avoids /threadsFOO
       location   /agents/threads/    { user }
       location   /agents/preview/    { user }   # artifact iframes, day one
       location = /agents/agents      { user, GET only }  # picker for thread create
       location = /agents/healthz     { public }
       location   /agents/            { user + admin-role check }

   The console needs `GET /agents` (agent picker) and `/preview/:token`
   (every artifact card) from day one — the original two-location split
   admin-gated both and broke non-admin users immediately. `/preview` is a
   deliberate capability exception: the token authorizes the whole thread's
   artifacts; say so here rather than pretend the owner guard covers it.
   The role gate must `cjson.decode` the X-USER JSON and check `roles`.
   Every user location sets `$x_user` from the verified token only and
   `proxy_set_header X-USER $x_user` (overwrites client copies). Public
   locations set `proxy_set_header X-USER ""` and must re-`include
   snippets/proxy-headers.conf` (a location-level `proxy_set_header`
   cancels ALL inherited ones).

4. **No SSE.** The engine is poll-only (`GET /threads/:id/steps`; the
   messages POST answers once at the end). The real streaming risk is the
   opposite: `proxy_read_timeout 3600s; proxy_send_timeout 3600s;` on the
   threads locations so long-running `POST /messages` isn't killed at
   nginx's 60s default.

5. **Body size.** `client_max_body_size` on the upload-taking locations,
   aligned with the engine cap (http-level default is 500M — tighten, since
   location-level overrides).

6. **Console** served through the same gateway host; the cookie rides along;
   zero token code in `app/`.

## nuraly.io — the same image, and one location

Written 2026-07-30, phase 5 of `app/MIGRATION-LUMENJS.md`. **Nothing in the
nuraly repo is changed by this section and nothing here is deployed.** The
tunnel keeps pointing where it points and the `lumen-agents.the-agent.dev`
block above keeps working exactly as written; this is what the hosted
deployment becomes when someone says go, recorded now because the shape of it
is what the console's phase 5 was built for.

Read that as the scope it has, which is this section: **it is a promise about
nuraly.io, not a statement that nothing on the-agent.dev ever moves.** The
section above it — the `lumen-agents.the-agent.dev` gateway — is deployed, and
deploying it is what put an authenticating front door in front of the console:
`/etc/cloudflared/config.yml` names the gateway on :8090 for both hostnames
rather than the console's dev server on :5173, and the gateway container was
replaced to load `locations/agents.conf`. A review that reads the sentence
above as absolute will find both and call them violations; they are that
section landing. What would be a violation is the reverse — pointing either
hostname straight at :5173 again, which publishes the engine's API to the
internet with no credential, and is what the tunnel did before. Check it the
way it is meant to be checked: `GET https://lumen-agents.the-agent.dev/threads`
answers 401 and `GET /` answers the console.

What changed is which process talks to the engine. Above, the gateway does:
ten locations, each one an engine route carrying its own auth, timeout and
body cap, and each one a place the next engine route can be forgotten. The
console on LumenJS proxies `/api`, `/preview` and `/whoami` to `AGENTS_API`
from inside its own process (`app/server/api-proxy.ts`), and `AUTH=proxy`
(`app/pages/_middleware.ts`) makes it take identity from the inbound `X-USER`
rather than ask anybody. So the gateway's whole job on this host becomes:
verify the caller, stamp `X-USER`, hand the request to the console. One
location — and the engine stops being something the edge routes to at all.

### The service

`docker-compose.prod.yml`, beside the gateway on `nuraly-network`:

    agents-console:
      image: ghcr.io/nuralyio/agents-console:${IMAGE_TAG:-latest}
      environment:
        AUTH: proxy
        AGENTS_API: http://host.docker.internal:8100
        AGENTS_PREVIEW_ORIGIN: https://lumen-artifacts.the-agent.dev
      extra_hosts:
        - "host.docker.internal:host-gateway"
      networks:
        - nuraly-network
      restart: unless-stopped

The same tag a community `docker compose up` builds and runs — one image, one
`AUTH` read once at boot, no hosted build and no feature flag. Four things
about that entry are load-bearing:

- **No `ports:`, and it is not tidiness.** `AUTH=proxy` believes whatever
  `X-USER` arrives, so anyone who can open a TCP connection to this container
  can name themselves any owner; the compose network is the whole of the
  boundary. The console checks its own posture and refuses to start when it
  can see a public address on its interfaces (`guardProxyBind`) — inside a
  bridge network it sees one private address and stays quiet, which is the
  deployment that check was written for. Publishing a port is how the check
  gets defeated by hand.
- **`extra_hosts`, the same entry and the same reason the gateway carries
  it.** The engine runs on the host, not in this network. The
  literal-vs-variable `proxy_pass` rule above does not apply to it —
  `AGENTS_API` is resolved by Node inside the console, not by nginx — but the
  name still has to exist inside the container.
- **`AGENTS_PREVIEW_ORIGIN` names a separate registrable domain and must keep
  naming one.** An artifact is a body a model wrote; same-origin with the
  console it would run beside the console's session. Set it here and set the
  engine's `AGENTS_PREVIEW_HOST` to the same host, or set neither — with it
  empty the console reads previews back through `/api`, where the engine
  answers `text/plain` and the bytes are inert.
- **`AGENTS_API_TOKEN` cannot be turned on from here.** Third precondition
  below.

### The location

In the server block that serves `nuraly.io` — today the default one, which
includes `locations/locations.conf` — above `locations/main.conf`'s
`location /`:

    # The agents console. One location, because the console proxies the
    # engine itself: there is no /threads, /preview or /api block on this
    # host, and an engine route added tomorrow needs no gateway edit.
    location /agents/ {
        set $x_user "";
        access_by_lua_block { require("main").authenticateRequired() }

        # Trailing slash: /agents/foo reaches the console as /foo. The
        # console is a root-mounted application and has no idea it is
        # behind a prefix — first precondition below.
        proxy_pass http://agents-console:8080/;
        proxy_http_version 1.1;

        # The socket is the phase-3 feed: thread pushes, live steps,
        # artifact versions. Without the upgrade pair it falls back to
        # long-polling and works, slower, which is the kind of breakage
        # nobody reports.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        include snippets/proxy-headers.conf;
        # The identity, and the only one the console will ever see: built
        # from a verified token, overwriting whatever the client sent. The
        # console forwards it to the engine untouched.
        proxy_set_header X-USER $x_user;

        # POST /threads/:id/messages answers once, at the end, after the
        # model and every tool call it made. Minutes, routinely.
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        # AGENTS_UPLOAD_BYTES_MAX is 1 MiB per file; the body is JSON, so a
        # binary file is base64 (×1.37) inside a string that escapes.
        client_max_body_size 4M;
    }

One location means one check, and the check is `authenticateRequired()` —
authentication, no role. The console refuses the configuration writes that
matter for it (`guardConfigWrites()`, "Where each check lives" above), which is
a floor rather than the wall this host should have: a `location
/agents/api/model-` and a `location /agents/api/providers` above this one,
each adding the role check the other server block uses, is the belt to that
braces and is the one edit this host still wants.

`agents-console` is a compose service name, so unlike `host.docker.internal`
it is a name Docker's embedded DNS does know — which is why the literal form
is correct here and the caveat is the opposite one: nginx resolves a literal
upstream once, at startup, so recreating the console container gives it a new
address the gateway will not learn until it is reloaded. `restart:
unless-stopped` covers a crash; a `docker compose up -d agents-console` that
replaces the container needs the gateway reloaded behind it, or the
`resolver 127.0.0.11 valid=10s;` + variable-`proxy_pass` form, which for this
upstream — and only for this one — actually works.

### Preconditions, in the order they will bite

1. **The console does not know it lives under `/agents/`, and the framework
   offers no way to tell it.** This is the one thing standing between the
   block above and a working host, so it is first. The built shell hardcodes
   `<script src="/assets/…">`; `src/api.ts` opens with `const BASE = "/api"`;
   the socket connects to `/socket.io/`. Mounted at a prefix, the first HTML
   response arrives correctly and every URL inside it points at nuraly.io's
   root — where `/api` is `locations/backend.conf`'s social backend and
   `/assets/` is the social bundle, whose entry chunk carries the same
   `__nk_build_` prefix because both applications are LumenJS builds. There
   is no option to set: `readProjectConfig` (`dev-server/config.ts`) scrapes
   `title`, `integrations`, `prefetch`, `securityHeaders` and a version out of
   `lumenjs.config.ts` with regular expressions, and neither `build/` nor
   `serve.ts` mentions a base anywhere. Two ways out, and they are not
   equivalent:

   - **A base path in the framework** — one field in `lumenjs.config.ts` that
     the build prefixes emitted asset URLs with and the router strips off
     incoming ones, with `src/api.ts`'s `BASE` derived from the same answer
     rather than written twice. Small, upstream, and the fifth concrete
     instance of risk 1. With it, the location above is the entire change.
   - **Give the console the whole of a name** — `agents.nuraly.io`, its own
     `server { }`, the same single `location /`, a DNS record and no code at
     all.

   Take the first. The reason is the cookie, and it is the same fact the
   `lumen-agents.the-agent.dev` block was built around: nuraly's session
   cookie is host-only (`session.ts` sets no `Domain=`), so a login on
   nuraly.io is invisible on any other hostname — which is why that host had
   to serve its own copy of the login pages. `nuraly.io/agents/` is the first
   arrangement where the console needs no login surface of its own, because
   the browser is already carrying the credential the gateway verifies. A
   subdomain buys a hostname and re-buys that whole problem.

2. **`/whoami` has no answer, and the failure is silent.** Today
   `location = /whoami` on the agents host runs `authenticateRequired` and
   echoes back the `X-USER` it just built — the gateway answering the one
   question only it can. With one location the request reaches the console
   instead, `AUTH=proxy` deliberately answers neither `/whoami` nor
   `/logout`, and `api-proxy.ts` forwards `/whoami` upstream to an engine
   that has no such route. `whoami()` in `src/api.ts` reads a non-`ok`
   response as `null` — "nothing authenticates here" — and the rail then
   hides the settings overlay from everyone, administrators included. Nothing
   errors; the console just quietly becomes read-only for its operators.

   The fix belongs in the console, not in a second location: `AUTH=proxy`
   should answer `/whoami` from the header it was handed, exactly as
   `builtin` answers it from the session. Each mode's job is to make the
   console's three seams true (`app/CLAUDE.md`), and this is one of the
   three. A second `location = /whoami` echoing `$x_user` also works and
   costs the one-location claim; prefer the console.

   The other two seams need nothing, and this is where the prefix mount pays
   for itself. `src/sidebar.ts` navigates to the absolute `/logout` and
   `src/api.ts` redirects a 401 to the absolute `/auth/login` — on nuraly.io
   both are already served, by `locations/authentication.conf`, by the
   identity provider that owns them. Root-absolute seams landing on the login
   surface in front is exactly what `AUTH=proxy` means.

3. **`AGENTS_API_TOKEN` has to stay off, or be given a way in.** The engine's
   bearer lock wants `Authorization: Bearer <token>` and the gateway used to
   send it. The console does not: `api-proxy.ts` forwards `req.headers`
   verbatim and adds no credential of its own, deliberately and by the same
   rule that governs `server/sockets.ts` — a token added there would let the
   server-side poller see conversations the page cannot. So on this
   deployment the engine's isolation is the firewall and the private network
   with the bearer lock off, until the console grows an explicit way to
   present a token that is not "forward whatever the browser sent". Decide
   which before the first request, because the alternative is discovering it
   as a 401 on every one of them.

4. **`ALLOWED_ORIGINS` must name `https://nuraly.io`.** Unchanged rule, new
   host: the Origin check fails closed, so unset is not "no check" — it is
   every POST and every preflight answering 403 with the cause only in the
   error log.

### What this does not touch

The engine, the Lua, owner scoping, `AGENTS_TRUST_PROXY_AUTH`, the artifacts
host and its preview-only confinement: all exactly as described in the rest of
this document. The gateway's verification contract is the same cookie and the
same code path — the console changed frameworks and the gateway is not
supposed to be able to tell, which is what `nuraly/e2e/agents` is for. The
tunnel is not touched: the console's port moves inside compose and nowhere a
DNS record can see.

## Engine changes (this repo — small, edition-neutral, dormant by default)

1. **`AGENTS_TRUST_PROXY_AUTH` gate (off by default).** When unset, `X-USER`
   is ignored entirely — today's behaviour, bit-for-bit. When set, the
   scoping below activates. This is Grafana's auth-proxy posture (off by
   default, explicit opt-in) instead of an always-honored header, and it
   makes a half-configured proxy fail safe instead of exposing everything.

2. **Migration 71 — the frozen-mapping dance, not a bare ALTER.** Migration
   19 generates its CREATE from the live `threadsMapping()`; touching the
   mapping rewrites 19's checksum (existing DBs refuse to start) and makes
   71's ALTER a duplicate-column error on fresh DBs. So: freeze
   `threadsMappingV1()` (the `modelsMappingV1` precedent in schema.ts),
   repoint 19 at it, then 71 is `ALTER TABLE threads ADD COLUMN owner TEXT
   NOT NULL DEFAULT ''` — `NOT NULL`, or "unowned" splits into NULL and ''.
   Index `(owner, created_at)`.

3. **One shared resolver, ~16 call sites.** There is no single thread-
   resolution point today: nine routes repeat the `threadAgent(...) == ""`
   check inline and seven more (workspace file read/remove/promote, artifact
   find/version/rotate/remove) resolve resources directly. The guard is a
   shared `ownedThread(db, threadId, tag)` — wrong tag → **404** (403 would
   confirm existence) — called first in every `/threads/:id/...` handler
   across all three controllers. The list side is SQL: `WHERE owner = tag`
   into `pageOrdered`, never a handler post-filter (breaks pagination, scans
   all tenants).

4. **Runs and traces do not hang off threads — scope or stop leaking.**
   `runs` has no thread link and no token columns; `GET /runs/:id` and
   `GET /agents/:id/runs` serve full conversation content unguarded, and the
   messages POST returns `runId`/`traceId` to end users. Stamp `owner` (and
   `thread_id`) on run rows and guard `/runs/:id` with the same tag rule —
   or stop returning run ids to non-admin callers. This also unblocks
   `GET /usage`: bytes are ready (`threadBytes`), but tokens are currently
   computed and dropped, so usage needs those columns persisted.

5. **Cutover semantics for legacy rows.** With the header present, return
   ONLY `owner = tag` rows — never `'' OR tag`, which would leak the entire
   pre-gateway history to every authenticated user. Turning the gateway on
   over an existing DB is an explicit one-time backfill of `owner`, or
   documented orphaning. With no header (community), everything behaves as
   today.

6. **Sweep — a thing that does not exist, and must stay opt-in if it
   ever does.** The draft called an abandoned-thread sweep a bug to fix;
   review found no such code has ever been written, so "fixing" it would
   have been new data loss shipped to the community edition. What ships
   is dormant: `AGENTS_SWEEP_IDLE_MS` unset means no pass is started and
   no row is ever deleted. Set, it runs on its own thread and never on
   `GET /threads` — a request-path sweep under scoping means any user's
   list deletes other users' threads — and it spares any thread holding a
   turn, an artifact, a step, an uploaded file **or a run**. The last two
   are the ones a symmetry argument misses: a thread opened by dropping a
   file in, and a thread whose first round failed before it could produce
   a turn, both of which the user is still looking at.

7. **Caps: engine env, one missing cap today.** Current caps are
   compile-time consts (`ARTIFACT_MAX` 512KB, `THREAD_BYTES_MAX` 100MB) and
   the workspace upload door has NO byte cap at all. Convert to env
   (`AGENTS_UPLOAD_BYTES_MAX`, …) with today's values as defaults, and cap
   the workspace door. Rule unchanged: the engine enforces the same limits
   for everyone; per-user quotas are control-plane, fed by `GET /usage`.

8. **`AGENTS_API_TOKEN` — reinstated as defense-in-depth.** The firewall is
   the isolation for `:8100`, but firewall-only means one missed rule or
   security-group drift = attacker-chosen identity with zero forgery (the
   most likely real-world breach path per review). When set, the engine
   wants `Authorization: Bearer <token>`; the gateway sends it. Off by
   default.

## Where each check lives, and the one gap we accept

The split matches the standard one — coarse-grained at the edge, fine-grained
in the service, cosmetic in the browser:

| layer | check | grain | needs state? |
|---|---|---|---|
| console | `isAdmin(me)` hides Settings | none — ergonomics only | no |
| console server | `guardConfigWrites()` → 403 | coarse: a claim and a path | no |
| gateway | `requireRole("admin")` → 403 | coarse: a claim and a path | no |
| engine | `ownedThread(tag)` → 404 | fine: is this row yours | yes |

Coarse-grained decisions are the ones answerable from the request alone, which
is why a proxy holding no database can make them. Ownership cannot be answered
that way, so it belongs where the rows are. The console's check is not a
control at all: the browser's code belongs to whoever is running it.

**The rule that keeps this honest: the UI may only hide what the gateway
already refuses.** The moment it hides something the gateway allows, the
hiding has silently become the security.

**The accepted gap.** Configuration routes (`/models`, `/prompts`, `/skills`,
`/providers`, …) have NO engine-side authorisation. Their only protection is
the gateway's role check. Textbook layering would have the service reject
unauthorised callers too — we do not, because roles in the engine is exactly
the identity knowledge `EDITIONS.md` refuses, and one honest wall beats two
half-implemented ones. What stands in for the second layer is
`AGENTS_API_TOKEN` and the firewall, which is why "`:8100` must never be
directly reachable" is a launch gate rather than advice: bypass the gateway
and the whole admin surface is open. Revisit only if the engine ever needs
roles for its own reasons.

**Where that gap actually bit, and the row in the table above that is new.**
The nuraly.io section below ships ONE location — `location /agents/` with
`authenticateRequired()` — and the console forwards every `/api/*` to the
engine's root with no path or method allowlist. So on that host the gateway's
role check does not exist: authentication is the whole wall, and any signed-in
user could `POST /agents/api/model-choices`. That was survivable while these
tables only described the deployment. The model menu changed it: those rows are
what every other user's composer offers and what their turns cost, and a
`model_choices` row inserted at rank 0 leads the menu for everybody.

So `pages/_middleware.ts` refuses non-GET requests to `/api/models`,
`/api/model-configs`, `/api/model-choices`, `/api/model-routers` and
`/api/providers` from a caller holding no `admin` role — in `builtin` and
`proxy` only, because `none` has one operator and nobody to distinguish them
from. Same grain as the gateway's check, made in the only process this repo
controls that stands in front of the engine on that host. It does not replace
the gateway's check and does not narrow the gap above: reads are untouched,
the other configuration routes still rely on the edge, and a caller who reaches
`:8100` directly still bypasses everything.

## Preconditions — hard launch gates, not notes

- **Secrets are broken today, twice.** `config/prod.env` still carries the
  literal placeholder `JWT_SECRET`, and `LUMENJS_JWT_SECRET` is referenced
  by the compose file but defined nowhere — the gateway container gets an
  empty string and auth silently no-ops. Rotate, wire both to the issuer's
  actual secret, and add a deploy-time check that fails on placeholder or
  empty. Two mechanics found while doing it: `LUMENJS_JWT_SECRET` must hold
  the **same value as `SOCIAL_SESSION_SECRET`**, because that is the secret
  `issueAccessToken` signs with; and a compose `environment:` entry spelled
  `- FOO=${FOO}` with `FOO` unset in the shell interpolates to `""` and
  **overrides `env_file`**, which is how the empty secret survived being
  written down.
- **`ALLOWED_ORIGINS` must name the console's own host.** On this host the
  Origin check fails closed, so unset is not "no check": it is every POST
  and every preflight answering 403 with the cause only in the error log.
  The deploy script asserts both variables in the running container.
- **The browser's credential has to be one the gateway can read.** A cookie
  login writes `nk-session`, an AES-GCM blob only the social app can open;
  the gateway verifies an HMAC JWT out of `nk-access-token`. Cookie-mode
  login, signup, TOTP and the OIDC callback now set both, and logout clears
  both. Without that half, a successful login is followed by a 401 on every
  single console request.
- **Firewall with the bridge exception.** Deny `:8100` from outside, but
  allow the Docker bridge range (e.g. `172.16.0.0/12`) first or the gateway
  502s itself. Post-deploy check: `:8100` must not answer from any
  non-local address. (Runtime binds 0.0.0.0 unconditionally — `LUMEN_BIND`
  is a language-level fix, tracked separately.)
- **Rotate the leaked GitHub PAT in this repo's remote URL.**

## Test (e2e, committed scripts per the scenario doctrine; they hit the
## gateway, so they live in the nuraly repo beside it)

- no token / garbage / expired → 401; valid Bearer → 200 with X-USER stamped
- client-supplied `X-USER`, no token → 401 **(required CI gate on any diff
  touching `locations/backend.conf` — the fail-open passthrough lives one
  function away in the same module)**, and the same header against a
  passthrough route reaches the upstream as nothing
- the cookie a real login writes — two segments, `nk-access-token` — is
  admitted, and an `nk-session` blob is not: minting a token in the test is
  how a suite passes while every browser gets a 401
- valid cookie → 200; non-GET with disallowed/absent-config Origin → 403
- two tags cannot see each other's threads, artifacts, workspace files,
  steps, or runs; cross-tenant artifact search returns nothing
- engine with `AGENTS_TRUST_PROXY_AUTH` unset ignores X-USER entirely
- long `POST /messages` (>60s) survives the proxy
- `/preview/:token` renders for a non-admin user

## Community / pro separation

No separation in code — separation by repo:

| ships here (AGPL, dormant without the env gate) | stays in nuraly / private repo |
|---|---|
| owner column, resolver, X-USER parse, trust gate | OpenResty auth, role gating, locations |
| env caps, defaults unchanged | quotas, plans, billing |
| `GET /usage` (generic accounting) | control plane, provisioning |

"A trusted proxy sets `X-USER`" is the documented community contract
(Grafana auth-proxy pattern): a self-hoster fronting the box with their own
nginx + basic-auth gets multi-user scoping for free. Guard rail, documented
loudly: when the trust gate is on, `:8100` must never be directly reachable
— the proxy is the trust boundary in both editions.

The split test, restated per review: zero pro *code paths* in the AGPL
source. Talking about the pro edition in docs is fine (open-core
transparency); shipping its branches is not.

## Product/licensing actions (from review, ordered by the clock)

1. **CLA before the first external PR** — one merged outside patch without
   it permanently breaks dual licensing for that code. Grant-style CLA
   (license grant + sublicensing), not copyright assignment (unenforceable
   in DE/AT, deters contributors). Add SPDX headers per file.
2. **Extract `packages/agents` to its own repo** sooner rather than later —
   subtree licensing is legally fine but GitHub badges the whole repo
   Apache-2.0 and contributors will assume Apache inbound. Extraction also
   moves this ops-adjacent plan out of a public tree.
3. **State the moat honestly**: AGPL forces publication of modifications
   only; it does not stop anyone from hosting the unmodified engine. The
   defensible part is the control plane, provisioning and ops.
4. **Sharing, pre-decided**: "share with a teammate" breaks single-tag
   equality. When it comes, the guard generalizes to "thread tag ∈ caller's
   tag set" (gateway sends a list) — ownership stays one tag, still no users
   table. Read-only share links fit the existing public-location escape
   hatch. Decide then; the resolver signature should take a list from day
   one to make that free.

## Explicitly out

Keycloak / OIDC (revisit for real SSO or per-tenant realms), auth inside
`api.ts` beyond the optional bearer lock, users tables, roles in the engine.

One thing that WAS on this list and came off it: nuraly's fail-open
passthrough. `authenticatePassthrough` returned early whenever the request
already carried an `X-USER`, on the theory that only internal services would
send one — at the internet edge, that was `curl -H 'X-USER: {"uuid":…}'` as
full impersonation against workflows, executions, whiteboards, kv and ocr.
Pre-existing is not the same as out of scope when the refactor is already
open in the file; the header is cleared unconditionally now, and the e2e
reads it back off the OCR upstream so it stays that way.
