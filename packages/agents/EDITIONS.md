# Two editions, one codebase

The product splits in two: a **community edition** — this repo, self-hosted,
no auth, bring your own keys — and a **pro edition**, the same engine run as
a managed cloud service. The first decision is the one everything else hangs
off:

**The editions are not two codebases and not one binary with an auth flag.
They are the same binary deployed two ways.**

## Why not auth-in-the-binary

Putting login, tenants and billing inside `api.ts` would thread a `tenantId`
through every table, every route and every test, and the community reader —
whose whole reason to choose this over a SaaS is that the thing is small
enough to read — would wade through machinery that is never on for them.
Half-on auth is also the worst security posture: a flag that defaults to off
WILL be off somewhere it mattered.

## Why not a fork

A fork buys two drifting products and every fix twice. The eval suite, the
skills, the validator plumbing — all of it is edition-independent and must
stay one thing.

## The shape: single-tenant engines, multi-tenant control plane

Community is what exists today: one API process, one database, one console,
one operator who owns the box. Authless **on purpose** — it binds where the
operator says and their reverse proxy is their auth, which is how the
self-hosted tools people actually trust (early Gitea, Ollama, most of the
local-AI wave) behave.

Pro is N of those, orchestrated:

    [customer] → cloud gateway (auth, billing, routing) → tenant's own engine
                                                          (own DB, own
                                                          containers, own
                                                          caps)

- **One engine + one database per tenant.** Tenant isolation is process and
  filesystem isolation, not WHERE clauses. The engine already fits this: the
  whole deployment is rows in its own DB, script runs are per-conversation
  containers, and the systemd `MemoryMax`+`Restart` unit pattern (proved on
  this very box) is the per-tenant resource cap.
- **The gateway owns identity.** SSO, API keys, seats, metering — none of it
  reaches this repo. The gateway injects nothing into the engine except the
  request; the engine keeps not knowing what a user is.
- **The control plane is a separate, private repo.** Provisioning (create
  tenant → migrate DB → start unit → wire hostname), billing hooks, the
  signup UI. It talks to engines over their ordinary API.

## There is no edition flag. That is the design.

The recurring question is *"which flag turns on the cloud version?"* — and the
answer is that none does, because a flag would mean the cloud's code lives in
this binary and is dead everywhere else. What actually differs is **what sits
in front of the process**:

    community        [operator] ─────────────────────────► :8100  ./api
                                     nothing in between

    pro              [customer] ──► gateway ──► per-tenant ──► :8100  ./api
                                    auth        network         (same binary,
                                    billing                      same build,
                                    routing                      own DB)

Both boxes run the identical `./api`. Neither knows an edition exists. Asked
who is calling, both answer the same way: nobody knows, and nothing in the
schema could hold the answer.

The engine does read environment — a token, a port, resource caps — but those
are operational knobs a self-hoster sets too, not an edition switch. Nothing
the engine reads has a value meaning "you are the cloud now".

The corollary is the useful part: **there is nothing to build here to be
ready for pro.** Readiness is a property this codebase already has, and keeps
by not adding a `tenantId`. The work of pro is the gateway and the
provisioner, in a private repo, against the ordinary HTTP API.

## What stays out of this repo

Login pages, tenant tables, billing, quotas-by-plan, the provisioner, TLS
management, the cloud console shell. All control-plane, all private repo.

## Deferred — do not build until a second customer exists

One instance is running today. A gateway, a tenant registry and a provisioner
built now would be maintained for a year before anything used them, and would
be built against guesses about what a tenant needs. Deferring costs nothing
precisely because of the section above.

- [ ] gateway (auth + route by hostname), tenant registry
- [ ] provisioner: systemd unit per tenant, DB create, cloudflared hostname
- [ ] metering: the engine already counts tokens per run — the gateway reads
      them off the run log route, the engine stays billing-blind
- [ ] compose file: engine + postgres + console, one command — when there are
      self-hosters to install it
- [ ] caps from env (`AGENTS_THREAD_BYTES_MAX`, script wall clock, artifact
      cap …) so pro tiers become env differences, not builds

## Worth doing now, for the one instance

- [ ] `AGENTS_API_TOKEN`: when set, every route wants `Authorization: Bearer
      <token>`. Not auth — a lock for a box that is reachable. Off by default,
      zero rows, zero schema.
- [ ] `GET /healthz` (version, migration mark, docker reachability) — what a
      restart script checks and a self-hoster curls first.
- [ ] **Bind address is not ours to fix.** `http.createServer(port, handler)`
      takes no host, and the runtime hardcodes `0.0.0.0` (six sites in
      `lumen_runtime_net.zig` / `lumen_runtime_os.zig`). So `AGENTS_BIND` is a
      language change, not an api.ts one — either a host parameter on
      `createServer` or a `LUMEN_BIND` the runtime reads. Until then every
      Lumen server binds every interface and the firewall is the only lock.
