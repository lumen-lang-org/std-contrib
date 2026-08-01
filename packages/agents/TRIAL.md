# Letting a stranger try it

A visitor who has not signed in should be able to open the console, ask a few
things, and see what the product does — then be asked to sign in to keep going.

This is a **pro-edition** concern. Community is authless by design (EDITIONS.md:
"one operator who owns the box", "their reverse proxy is their auth"), so on a
community install every visitor is already the operator and none of the
machinery below switches on. That is the test for every decision here: it must
cost the community reader nothing.

## Most of this already exists

`tagsFromHeader` (owner.ts) turns whatever the trusted proxy put in `X-USER`
into the caller's tag, and `ownerClause` scopes every list and every read to it.
Nothing in the engine knows or cares whether that tag names a person.

So a trial visitor is **a caller with a tag like any other**:

    X-USER: anon:9f2c1e7a-…

and isolation is already correct — `ownerClause` filters their threads to their
tag, the same statement that serves a signed-in caller. No new column, no new
predicate, no second code path through the read side.

The gateway issues the tag: no session cookie → mint an anon id, set it as a
cookie, stamp it as `X-USER`. That is one `access_by_lua_block` beside the
`authenticate()` call that is already in locations/agents.conf.

## The one thing that must not be got wrong

**An anonymous caller must never resolve to the empty tag.**

Two distinct ways to arrive at "" and both are wrong here:

- `owner = ""` on a row means *unowned* — "every thread written before there
  were owners, and every thread written by a deployment with no proxy in
  front" (threads.ts). On nuraly.io there are real rows like that. An anon
  caller stamped `X-USER: ""` would match every one of them.
- `tagsFromHeader` returns `[]` when the proxy is not trusted, and
  `ownerClause` reads an empty tag list as **unscoped** — the caller sees
  everything. That is correct for community, where there is one operator; it
  is a full disclosure for a stranger on a multi-user box.

So: the gateway stamps a non-empty `anon:` tag or it does not admit the
request. Not "defaults to empty on failure" — the failure mode is the leak.

The `anon:` prefix is load-bearing beyond readability: it is what every limit
below keys off, so an ordinary user is never accidentally rate-limited and a
trial user can never be accidentally unlimited.

## What a trial visitor may do

| | |
|---|---|
| turns | a small number per anon id — `AGENTS_TRIAL_TURNS`, alongside the Phase 2 caps |
| model | pinned to the cheapest choice; the picker is visible but disabled |
| Auto | **off** — a router may escalate, and a trial must have a knowable cost ceiling |
| premium | never, whatever `tier` a choice carries |
| skills, scripts, uploads | off. `run_script` starts a container per conversation; that is not a thing to hand an unauthenticated stranger |
| artifacts | readable in-session, not persisted past the sweep |

The model pin is the direct tie to MODEL-CHOICE.md, and it wants to be
expressed once: a trial caller's choice resolves to the first non-premium
choice in rank order, and the messages POST refuses any `modelChoiceId` that
is not that one. Enforced server-side — the picker being disabled in the UI is
a courtesy, not the control.

## Abuse, honestly

This gives anyone with a browser free model tokens. Clearing a cookie mints a
new anon id, so the per-id turn cap is a speed bump, not a wall. What actually
holds:

- **A per-IP cap at the gateway**, which is where rate limiting belongs and
  where nginx already does it.
- **A global daily trial budget** on the engine — a number of turns per day
  across all `anon:` tags, refused with a plain message when spent. This is
  the backstop that decides what the worst day costs, and it is the one to
  set first. Without it every other limit is per-attacker rather than total.
- **The cheapest model only**, which is what makes the budget number
  affordable rather than theoretical.

None of this makes trial abuse-proof. It makes the worst case a bounded,
known amount of money, which is the achievable goal.

## Keeping the conversation

A visitor who signs up should not lose what they just did. Their threads carry
`owner = "anon:<id>"`, so claiming them is one UPDATE from that tag to the new
owner tag, run at the moment the account is created while the anon cookie is
still in the request.

The console should say so before the cap is reached — "sign in to keep this
conversation" — rather than after, when the answer to "keep what?" is nothing.

## Expiry

Anon threads are litter by default: most are one question from someone who
never came back. `sweepEmptyThreads` and `AGENTS_SWEEP_IDLE_MS` already exist
and already run on their own thread rather than on a request path (the rule
there is load-bearing — "a read that destroys rows is, the moment threads have
owners, one person's sidebar deleting somebody else's conversations"). Extend
the same sweeper with an `anon:`-prefixed rule and a shorter idle window.

Claimed threads are no longer `anon:` and stop matching it, which is the
correct behaviour and needs no extra flag.

## What this does not need

No new tables. No new auth mode — `AUTH=proxy` already covers it, and the
console still branches on nothing (app/CLAUDE.md: "nothing under `src/` may
branch on the mode"). The console asks `/whoami` and renders what it is told;
a trial caller is simply a caller whose identity says it is provisional.
