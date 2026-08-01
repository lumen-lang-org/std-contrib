# Console → LumenJS migration plan

2026-07-30. Decision made: the console moves from Vite to LumenJS
(`@nuraly/lumenjs`, MIT) — for the socket layer first, the in-process auth
second, and one-codebase community/nuraly.io shipping third. The engine and
the gateway's verification contract change **not at all**.

What was verified before writing this: lumenjs is a file-routed framework
(social's `pages/` with `_layout.ts`/`_middleware.ts`, `auth/` pages), ships
`auth` (native + OIDC + session + guard), `communication` (sockets,
signaling, store), `runtime` (app-shell, component-loader, error-boundary),
and a `dev-server` with nuraly-ui aliasing. Social consumes it as
`file:../../libs/lumenjs` — so first order of business is a consumable
release of the framework itself.

## Target shape

    packages/agents/app/
      pages/
        index.ts            the console (chat + rails), today's console.ts
        auth/               only mounted when AUTH=builtin — lumenjs's pages
        _layout.ts          tokens, fonts, theme — from index.html
        _middleware.ts      AUTH dispatch (below)
      src/                  the Lit elements, moved nearly untouched
      server/
        api-proxy.ts        /api → AGENTS_API, /preview → same, Host rules
        sockets.ts          thread-list pushes, step streams, titles (#28)
      Dockerfile            one image: ghcr.io/nuralyio/agents-console
      compose.yaml          community: console + engine + postgres
      e2e/                  playwright, pointed at the lumenjs server

One image, one `AUTH` tri-state read at boot, no other mode switches:

| AUTH      | login served by      | X-USER comes from            | who runs this        |
|-----------|----------------------|------------------------------|----------------------|
| `none`    | nobody               | absent — engine gate off     | laptop, single owner |
| `builtin` | this app (lumenjs)   | this app's session middleware| team box, community  |
| `proxy`   | upstream gateway     | trusted inbound header       | nuraly.io, any IdP   |

`proxy` mode trusts inbound `X-USER` — acceptable ONLY because the app then
binds a private interface behind its gateway; the compose files enforce that
posture, and `AUTH=proxy` with a public bind refuses to start.

## Phases

**0. Framework release gate (blocks everything, not ours to skip). Done.**
std-contrib cannot depend on a relative path into another repo, so the
framework is vendored as a tarball and pinned — see "How lumenjs is vendored
today" below for the recipe and for why the interim is not the answer.
Licensing note landed in LICENSING.md: the app stays under the agents
package's AGPL; lumenjs is an MIT dependency like lit.

**1. Spike (1 day, throwaway allowed, decision checkpoint).**
Boot a lumenjs app that: serves one page rendering `<agent-console>` from
the existing bundle; proxies `/api` to :8100 preserving the two Vite rules
that exist for reasons (no changeOrigin — the preview Host contract; the
`/whoami` route that must NOT fall through to the SPA); opens one socket and
pushes a fake thread-title to the sidebar. Exit criteria: dev-server DX is
acceptable, LumenUI aliasing works, proxy semantics reproducible. If the
spike fails any of the three, stop and report — the plan does not proceed on
charm.

**2. Shell port (2 days).**
- `pages/index.ts` + `_layout.ts` replace `index.html`/`main.ts`; the meta
  tags the console reads (`agents-preview-origin`) become layout config.
- `src/` elements move as-is; only `main.ts` bootstrap and the
  `ui.ts` bundle-loading order need care (the LumenUI double-define trap is
  documented in app/CLAUDE.md — re-verify under lumenjs's loader).
- `server/api-proxy.ts` reimplements vite.config.ts's proxy table verbatim,
  including `/whoami` and the preview-Host comment block.
- Delete nothing Vite yet; `npm run dev:vite` stays until phase 5.

**3. Sockets — the payoff. Done.**
- Server: `server/sockets.ts`, re-exported as `socket` from `pages/index.ts`
  — the export LumenJS scans a page for. It polls the engine (still poll-only,
  still by design) for the three things the browser used to ask about and
  pushes each on change: `/threads?limit=50` every 5s, the watched thread's
  `/steps` at 400ms while a round runs and 1.5s while none does, and its
  `/artifacts` every 4s. The browser says which conversation it is looking at
  with one `watch` event.
- Discovery by timer, though, is not a latency anyone would accept: a change
  made in one browser reached a second browser only when *that* browser's
  poller next came round, so `e2e/live-fanout.spec.ts` measured 2.9–3.5s
  against its 2s budget, 10 times out of 10 — not flake, the design.
  `server/nudge.ts` closes it. Every write the console makes goes through
  `server/api-proxy.ts`, so the proxy calls `noteWrite()` on any non-GET
  `/api` request the engine answered 2xx, and each socket's thread loop asks
  again at once instead of waiting. Re-measured 28–390ms, 10 of 10.
- What crosses that seam is a bare "something was written" — no id, no body,
  no identity. Each socket answers it by asking the engine with its own
  browser's credentials, exactly as its timer would have, and pushes only if
  its own answer moved; a write by one owner can therefore make another
  owner's socket ask sooner but can never put a row in its sidebar. That is
  the whole reason the signal is allowed to reach every connected socket, and
  the reason it must stay empty.
- The timers are untouched by it: `THREADS_MS` stays 5s as the floor for a
  write that never passed through this process — a second console, a script,
  a title the engine derived on its own. Lowering it to buy latency would
  charge every socket every five seconds forever for something that happens
  when a person presses Enter. A nudged loop will not ask more than twice a
  second (`KICK_GAP_MS`), so a client hammering a write endpoint cannot turn
  the socket layer into an amplifier pointed at the engine.
- Client: `src/live.ts` is a bus, not a transport. LumenJS's router owns the
  socket; `pages/index.ts` forwards the two seams it offers — the pushed
  `live` property and the injected `emit` — into the bus, and the console's
  regions subscribe. Under Vite there is no router, so nothing arrives and
  every poller runs exactly as before.
- Fallback: the three timers are never cancelled, only skipped while
  `live.fresh()`. Freshness is a 2s server heartbeat against a 6s window,
  which is faster than Socket.IO's own disconnect detection (15s ping, 10s
  timeout). `e2e/live.spec.ts` asserts both halves — zero polls with the feed
  up, polling back within 16s of `setOffline(true)` — and skips itself
  entirely on a server with no socket.
- Backlog #28's console half landed: a title reaching a second tab's sidebar
  with that tab making no `/api` request at all. The titling agent itself is
  engine work and is not part of this phase.

What phase 3 decided and why, so it is not relitigated:

- **One poller per socket, not one per identity.** Fanning out across sockets
  means keying a cache by who is asking, and two sockets are two credentials;
  anything short of the whole credential as the key is a way for one owner's
  conversations to reach another owner's sidebar. Engine load is therefore
  unchanged — the same number of pollers, moved from browsers to the server.
  What the phase buys is that the polling leaves the WAN.
- **The poller reaches the engine with the browser's own headers** — cookie,
  `X-USER`, `authorization`, and nothing invented. api-proxy.ts adds no
  credential of its own, so neither may this; a token added here would let the
  socket see conversations the page cannot.
- **`server/engine.ts`** exists because the proxy and the poller must agree
  about `AGENTS_API`. It is free of `node:` imports on purpose: `sockets.ts`
  is reachable from a browser module through that re-export in
  `pages/index.ts`, so everything it pulls in gets bundled for a page that
  will never call it. `server/nudge.ts` is free of them for the same reason.
- **The nudge registry hangs off `globalThis`, and that is not ESM paranoia.**
  Its two callers are loaded by two different module systems. In `lumenjs dev`
  both `lumenjs.server.js` and `pages/index.ts` go through Vite's
  `ssrLoadModule` and would share a module scope; under `lumenjs serve` the
  page is a Rollup bundle with `sockets.ts` inlined and the middleware is
  compiled beside it — two copies, and a nudge landing in an empty set. A
  registry that works in dev and quietly does nothing in the shipped image is
  worse than none, because the e2e that proves it runs against dev.
- **The seam is the proxy, not `room.broadcast`.** LumenJS does offer sockets
  a `room` handle, but only from inside a connection, and the event here does
  not originate at a socket: it originates at an HTTP write. Rebroadcasting
  one socket's *discovery* to the others would leave the discovery itself on a
  timer — the actual defect — and would move an answer between credentials. A
  framework-level handle on the namespace from outside a connection would let
  the registry go; that belongs in risk 1's small-patches budget, not here.

**4. AUTH tri-state (1 day). Done.**
- `pages/_middleware.ts` holds the switch, read once at module load: `none`
  contributes no middleware at all; `builtin` resolves a session and sets
  X-USER for the proxy and the engine; `proxy` passes the inbound X-USER
  through untouched. An unrecognised `AUTH` exits rather than rounding to
  the nearest safe thing.
- `builtin` gets its own database — `data/console-auth.sqlite`, named in
  lumenjs.config.ts, never the engine's, which is another process behind
  AGENTS_API and names its own store with `AGENTS_PG_*`/`AGENTS_DB_FILE`.
  `pages/auth/` is the sign-in card; `server/auth-builtin.ts` drives the
  framework's own routes, password hashing and session sealing, and
  reimplements none of them.
- The console's `whoami()`/401-redirect code needed zero change, and the
  file's mtime says so: `src/api.ts` was last touched hours before this
  phase began. `builtin` answers `/whoami` itself in the gateway's document
  shape and 401s `/api` for a visitor with no session, which is what makes
  `toLogin()` fire without knowing why. `/logout` — the path `src/sidebar.ts`
  navigates to because the gateway serves it in `proxy` — is aliased to the
  framework's logout route by the middleware rather than changed in `src/`.
- `e2e/auth.spec.ts` drives the card in a browser and skips itself on a
  console that is not in `builtin`, the same judgement `live.spec.ts` makes.
  Six tests; they pass against `AUTH=builtin` and skip against the Vite
  server and against `AUTH=none`.

What phase 4 found, so phase 5 budgets for it:

- **The `auth` integration cannot be used, and the reason is ordering.** The
  framework registers its session middleware AFTER the global
  `lumenjs.server.js` chain — `dev-server/server.ts` puts `authPlugins.pre`
  after `userServerMiddlewarePlugin`, `build/serve.ts` runs the global chain
  before it. `server/api-proxy.ts` IS that global chain, so `req.nkAuth`
  first exists one middleware after the `/api` request it describes went
  upstream headerless. Identity has to be resolved ahead of the proxy, so
  `server/auth-builtin.ts` drives LumenJS's auth pieces directly. Upstream
  fix: let user middleware run after the auth middleware, or let an app say
  which side it wants. This is the fourth concrete instance of risk 1.
- **`integrations` is scraped out of lumenjs.config.ts with a regular
  expression**, not evaluated (`dev-server/config.ts`), so the list cannot
  depend on `AUTH` even in principle — on would mean on in all three modes.
- **The framework's session middleware skips any path containing a `.`**,
  which is every artifact asset under `/preview/`. In `builtin` a skip means
  no identity, and no identity means 401, so a signed-in user's artifacts
  would not load. `readSession` deliberately has no such skip.
- **`lumenjs serve` binds every interface** — `server.listen(port)` with no
  host, and no environment variable that changes it. `AGENTS_CONSOLE_BIND`
  is honoured only under `lumenjs dev`, where `lumenjs.plugins.js` sets it.
  The `proxy` bind check reads the same variable the same way, so the guess
  it makes matches what the server actually did; anything that is not `dev`
  is treated as a wildcard, because a check like this is only worth having
  if it errs toward refusing.

**5. Ship (1 day). Written, not deployed.**
- `Dockerfile` builds one image, `ghcr.io/nuralyio/agents-console`, from this
  directory as the whole build context — which is what the vendored tarball
  bought: social's file spends two stages compiling nuraly-ui and lumenjs from
  a monorepo checkout before it can start on the app, and here both arrive
  from `node_modules`. nginx is gone with the old image; the app is the server
  and `server/api-proxy.ts` is the only copy of the proxy rules.
- `compose.yaml` beside it: console + engine + indexer + PostgreSQL, `AUTH=
  none`, published to loopback, one `docker compose up --build`. The old
  `packages/agents/docker-compose.yml` is deleted rather than kept in step —
  it built the nginx image, and two files claiming to be the self-contained
  stack is how one of them goes stale.
- nuraly.io is a service entry plus one gateway `location` in GATEWAY.md,
  written and not applied. One location and not ten, because the console
  proxies the engine itself now; the section names the four things that have
  to be true before it is applied, and the first of them — the console has no
  idea it is mounted under `/agents/`, and LumenJS has no base-path option —
  is the fifth instance of risk 1.
- Vite is gone: `vite.config.ts`, `index.html`, `src/main.ts`, `nginx.conf`,
  `dist/`, the dependency and the `dev:vite` script. `lumenjs.plugins.js` is
  now the only copy of what that config held; the framework's own dev server
  is still a Vite server, so a comment naming Vite's `ssrLoadModule` or its
  host check is describing the framework and stays.
- The tunnel is untouched. The app's port moves inside compose, where no DNS
  record can see it.

What phase 5 found, and what it did about it:

- **`lumenjs.server.js` cannot ship as source.** `loadUserServerMiddleware`
  imports it with plain Node, and it imports `pages/_middleware.ts` and
  `server/api-proxy.ts` — `Unknown file extension ".ts"`, which that loader
  catches, warns about, and answers with an empty array. The image would boot
  a console with no proxy and no auth, answering `/whoami` with the SPA's own
  HTML, which `src/api.ts` reads as "nothing authenticates here" before
  offering every admin tool to everybody. So the Dockerfile bundles the file
  with esbuild and copies the result over that name; the `.ts` source is not
  in the image, because two files answering to one convention — one of which
  silently disables the proxy — is not a thing to leave lying about. It is
  also why `server/nudge.ts` keeps its registry on `globalThis`: that is now
  two bundles and two module scopes in production, exactly as phase 3
  predicted.
- **`lumenjs serve` sets a Content-Security-Policy and `lumenjs dev` does
  not.** The framework's default names no `frame-src`, so frames fall back to
  `default-src 'self'` and every artifact preview in the shipped image is a
  blank rectangle — while the identical page under `npm run dev` renders it.
  `server/csp.ts` widens exactly one directive, only when a policy is already
  there. A rule that cannot be found by running the console the way it is
  developed is the argument for reading the image's headers before shipping
  it, not only its pages.
- **The image could not be built, and the reason was not LumenJS. Fixed.**
  `src/ui.ts` imports `@nuraly/lumenui/overlay/bundle` — `nr-overlay` is the
  settings surface — and the published `@nuraly/lumenui@0.16.1` does not
  contain that component. Verified against the registry rather than guessed:
  `npm pack @nuraly/lumenui@0.16.1` unpacks 49 component bundles and no
  `overlay` directory at all, while the same version's source in
  `libs/nuraly-ui` has one. The working tree's `node_modules` had it from
  somewhere the lockfile does not describe, so `npm run dev` worked, `npm ci`
  did not, and `npx lumenjs build` failed at the client bundle with "Rollup
  failed to resolve import". The Dockerfile is `npm ci` followed by that
  build, so it failed there too — which was the Dockerfile doing its job: an
  image is a clean install, and it is the first thing in this project that has
  been. LumenUI is now vendored exactly as the framework is, above; publishing
  a release that ships `overlay` is still the answer this is the interim for.
  The image builds, runs, answers `/`, proxies `/api`, reports healthy, and
  opens a conversation from the composer — the first time any of that has been
  true of the shipped artefact rather than of a dev server.
- **The engine's bearer lock has no way in.** `AGENTS_API_TOKEN` was sent by
  the gateway; with the console in front, nothing sends it — `api-proxy.ts`
  forwards the browser's headers and adds no credential of its own, by the
  same rule that governs the socket poller. Recorded in GATEWAY.md as a
  precondition rather than papered over here.

## How the nuraly libraries are vendored today

**Publishing to npm is the answer. This is the interim.** Three nuraly
libraries are now committed beside the app as tarballs, for the same reason
and by the same recipe:

    vendor/nuraly-lumenjs-0.16.2.tgz
    vendor/nuraly-lumenui-0.16.2.tgz
    vendor/nuralyui-common-0.1.5.tgz
    package.json → "@nuraly/lumenjs": "file:vendor/nuraly-lumenjs-0.16.2.tgz"
                   "@nuraly/lumenui":  "file:vendor/nuraly-lumenui-0.16.2.tgz"
                   "@nuralyui/common": "file:vendor/nuralyui-common-0.1.5.tgz"

The names lost their suffixes when nuraly cut 0.16.2 with every fix in them;
`vendor/` still holds the suffixed 0.16.1 builds those were assembled from,
and the paragraphs below were written about those. Read them for the recipe
and for what each fix was, not for the filenames — and check the two invariants
at the end of this section against whatever is pinned, because they are what
the suffixes existed to make checkable. Neither 0.16.2 nor 0.16.3 is on the
registry yet (`npm view @nuraly/lumenjs versions` stops at 0.16.0), so the
`file:` lines stay until the publish workflow lands them.

`package-lock.json` carries each tarball's integrity hash, so the bytes are
pinned as firmly as a registry version would be. Refreshing either:

    cd /home/ubuntu/nuraly/libs/<lumenjs|nuraly-ui>
    npm run build          # NOT optional — see below
    npm pack
    mv nuraly-<pkg>-<v>.tgz <app>/vendor/<the suffixed name>
    npm install "@nuraly/<pkg>@file:vendor/<the suffixed name>"

**Reinstall by name, not by re-running `npm install`.** A `file:` dependency
whose path has not changed is not re-resolved, so the lockfile keeps the hash
of the tarball that used to be at that path and `npm ci` then fails
`EINTEGRITY` in the image while the developer's tree looks fine. Naming the
package on the command line forces the hash to be recomputed. Check it: the
`integrity` in package-lock.json must equal
`sha512-$(openssl dgst -sha512 -binary vendor/<file> | base64)`.

**Build before packing, every time.** `files` ships `dist/`, and the build
runs from `prepublishOnly`, which `npm pack` does not trigger — only
`npm publish` does. The checked-in `dist/` was three months stale when the
first lumenjs tarball was cut and contained neither auth fix; packing without
building would have shipped a framework that looks right and 401s every
browser at the edge.

**The filename is not the package version.** Inside, each `package.json` still
says `0.16.1`, and neither is registry `0.16.1`. The suffix says what is
extra, so nobody swaps one for a registry build and silently reimports what
it was cut to carry:

- `-edge-cookies-ssr` — the two auth fixes of risk 4 (dual cookie writing,
  roles as a JSON array), plus the two dev-server SSR fixes recorded under
  "What phase 2 found in the framework" below. All four are uncommitted in
  the nuraly working tree.
- `-overlay` — the `overlay` component, which no published `@nuraly/lumenui`
  contains and `src/ui.ts` imports, plus the `workflow-node` fix below. It is
  a build of `libs/nuraly-ui`'s working tree, so it also carries that tree's
  other uncommitted `canvas` edits.

**The canvas node fix, because it is the reason half the graph's tests
failed.** `workflow-node`'s `:host` is `position: absolute` and was given no
coordinates: `left`/`top` went onto the `.node-container` inside its shadow
root, which is `position: relative`. A relative offset moves the painting and
leaves the box where it was, so every node's host box stayed stacked at the
layer's origin while its card was painted where the layout asked. The graph
looked correct in a screenshot and could not be used — the hosts all overlapped
in the top-left corner, the last node in DOM order took the pointer for that
whole rectangle, and clicking an agent selected whichever tool rendered last.
Eight of `e2e/canvas.spec.ts`'s sixteen tests failed on it, four of them by
timing out on a click that could never land. `workflow-node.component.ts` now
writes the position to the host and the four node kinds no longer write it to
their containers; the painted result is identical.

When the fixes land on nuraly's `main` and the release workflow bumps the
versions, both suffixes go away and both lines become registry ranges.

**Verify these two on every refresh** — builtin auth depends on both, and
each was a production 401 once:

- *Dual cookie writing.* Every path that issues a login sets `nk-session`
  (the AES-GCM blob only the app can open) **and** `nk-access-token` (the
  HMAC JWT the gateway verifies): `login`, `signup`, `oidc-callback`,
  `totp`. Both `logout` paths clear both. `grep -l AccessTokenCookie
  node_modules/@nuraly/lumenjs/dist/auth/routes/*.js` must list five files.
- *Roles as a JSON array.* The JWT payload's `roles` claim is a real array,
  empty-array included — the gateway Lua does `ipairs` over it and encodes
  it into X-USER, and an object where the shape says list breaks the role
  gate.

## What phase 2 found in the framework

Three upstream defects. Two of them are now fixed in
`/home/ubuntu/nuraly/libs/lumenjs` and carried in the vendored tarball's
`-ssr` suffix; the first is still open. They are the concrete shape of
risk 1.

1. **`better-sqlite3` is a dependency of *starting* the server, not of using
   a database.** `dev-server/server.js` imports the auth plugin at the top of
   the file, unconditionally; that plugin imports `db/index.js`, which imports
   `better-sqlite3`. The dev server throws `ERR_MODULE_NOT_FOUND` before it
   reads `lumenjs.config.ts` and discovers that this app asks for no
   integrations and owns no database. The package is declared an optional
   peer, which is right; the eager import is the bug. Carried here as a
   devDependency meanwhile — and phase 5 meets it again, because the image
   needs the module present for `lumenjs serve` to boot, for a database it
   will not open until phase 4 gives `builtin` one. Fix: import it lazily
   inside the auth plugin.

2. **SSR worked once per server and then stopped. Fixed upstream.**
   `ssr-render.ts`'s `invalidateSsrModule` assigned `m.ssrModule = null`, and
   Vite 6 replaced the module graph with one graph per environment and left
   `ModuleNode` behind as a read-only view over the pair — `ssrModule` and
   `ssrTransformResult` are getters with no setter. In an ES module that is a
   `TypeError`, it landed in `renderPage`'s catch, and every request after the
   first took the documented "fall back to CSR" path: 127 of them in one e2e
   run. The clearing was never needed in the first place —
   `EnvironmentModuleGraph.invalidateModule`, already called on the line
   above, sets `transformResult`, `ssrModule` and `ssrError` to null on both
   sides — so the fix is to delete the two assignments there and to invalidate
   rather than assign in `server.ts`'s `handleHotUpdate`, which had the same
   pair. The console's pixels are unchanged either way (that was checked when
   the defect was found, by diffing screenshots of both servers — zero
   differing pixels of 640,000, on the chat view and on the agent graph); what
   is gone is a stack trace per page load and a framework that quietly does
   not do the thing it says it does.

3. **A dynamic import was evaluated on the server, once per render. Fixed
   upstream.** `pages/index.ts` guards its `import("../src/console.js")` with
   `import.meta.env.SSR` so the browser graph never reaches Node. It reached
   it anyway: `ssr-render` walks the page module's `ssrImportedModules`
   looking for component loaders and calls `ssrLoadModule` on each, and Vite
   lists dynamic imports there alongside static ones — `staticImportedUrls`
   does not separate them either, which was measured before it was believed.
   The result was one `module is not defined` from highlight.js, logged by
   Vite's own module runner before the walk's try/catch could see it. Fixing
   defect 2 turned that from once per server start into once per page load,
   because invalidation began actually working. The walk now remembers which
   files are not component loaders — a module either exports `loader` or it
   does not, and one that cannot be evaluated in Node never will be — and
   forgets a file when it changes. One line per server start, and the walk
   stops re-evaluating every module the page imports on every render.

## What does not change, said once

Engine: nothing. Gateway verification: same cookie, same Lua. Owner
scoping, caps, `/healthz`, `/usage`: untouched. The artifacts host and its
preview-only confinement: untouched. The Lit components and the Kimi
design: pixel-identical or the port is wrong.

## Risks, ranked

1. **lumenjs maturity for an external consumer** — social is its only real
   app and it has no published release. The spike exists to surface this
   early; expect to land small patches in lumenjs itself and treat them as
   part of the project.
2. **The LumenUI bundle-collision trap** under a different loader — the
   known failure mode is a blank console during module load. Re-verify in
   the spike, first thing.
3. **Proxy-semantics drift** — the preview Host rules and `/whoami` were
   each a production bug once already. The api-proxy carries their comments
   over verbatim and both get e2e assertions.
4. **`builtin` auth divergence** — lumenjs auth was patched here (dual
   cookies, roles-as-array). Those fixes live in nuraly's lumenjs; the
   published release must contain them or builtin mode re-imports both
   bugs.

## Estimate

6–8 working days after phase 0, spike verdict at day 1. Phases 2–4 are
sequential; 5 overlaps.
