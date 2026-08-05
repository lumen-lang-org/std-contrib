# Build prompt — scheduled tasks for Joule

Hand this whole file to whoever (or whatever) builds the feature. It is written
to be executed, not admired: every constraint in it is something this codebase
already proved, and the "Traps" section is the part that saves a day.

---

## The task

Build **scheduled tasks** in Joule — the feature ChatGPT calls *Tasks* and Kimi
calls *定时任务*. A person describes something they want done later or
repeatedly ("every weekday at 8, summarise what changed in my Linear cycle"),
Joule confirms the schedule, and from then on it runs that instruction on its
own and leaves the answer where the person will find it.

Ship it end to end: engine table, engine routes, the background thread that
fires, the console surface, tests, deployed and verified on joule.sh.

## What the feature is, precisely

A **task** is: an owner, an agent, an instruction, a schedule, and a switch.

Fire = one agent run against a fresh conversation. The conversation appears in
the sidebar the way any other conversation does — that is the whole delivery
mechanism, and it is why this feature is small. There is no separate "results"
store, no second rendering path, no new message type. A task that fired is a
conversation somebody did not have to type.

Behaviour to match, taken from the two products named:

1. **Created from the composer, in words.** Someone types the request; the
   model proposes `{title, instruction, schedule, timezone}`; the console draws
   a confirmation card; the person accepts or edits. Creating one from a form
   must also work — the card is sugar on a real API, never the only door.
2. **One-off and recurring.** "Tomorrow at 9" and "every weekday at 8" are both
   tasks. A one-off deletes itself after it fires (status `done`, kept visible
   for a day, then swept).
3. **A management surface**: list, next run, last run and how it went, pause,
   resume, edit, delete, and **run now** (which is also how anyone tests one
   without waiting for the clock).
4. **A notification when a run lands.** For v1 this is in-app only: an unread
   mark on the conversation and a count on the sidebar entry. See *Delivery*.
5. **Limits, enforced server-side**: at most 10 enabled tasks per owner, no
   interval under 15 minutes, and a task that fails 5 times running pauses
   itself with the reason recorded. These are not nice-to-haves — an agent run
   costs a provider call, and a scheduler is a loop with a credit card.

## Where it goes

Engine (Lumen) — `packages/agents/`:

| file | what to add |
| --- | --- |
| `tasks.ts` *(new)* | the row mapping, its migrations, the next-fire maths, and claim/complete. Pure functions and SQL — **no loop, no thread, no process**. This module owns its migrations the way `plugincards.ts` owns 97.x and `webrag.ts` owns 95 — take **98**. |
| `tasks.test.ts` *(new)* | table-driven tests for next-fire. This is where the bugs are. |
| `api.ts` | a `@controller("/tasks")` class beside the others. The engine serves the CRUD and **fires nothing**. |
| `scheduler.ts` *(new binary)* | one pass: claim what is due, run it, record it, exit. Built and deployed like `indexer`. |
| `joule-scheduler.service` + `.timer` *(new)* | the clock. See *The runner*. |
| `schema.ts` | nothing, if `tasks.ts` carries its own migrations — confirm the plan concatenates module migrations before assuming it. |

Console (LumenJS + Lit) — `packages/agents/app/`:

| file | what to add |
| --- | --- |
| `src/tasks.ts` *(new)* | the overlay: list, edit, pause, delete, run-now. Model it on `src/settings.ts` — same overlay idiom, `no-header`, in-body close/expand. |
| `src/sidebar.ts` | one `data-nav="tasks"` entry with a count badge when tasks are due or unread. |
| `src/chat-session.ts` | the confirmation card, rendered from the model's proposal the same way tool cards already render. |
| `src/api.ts` | the five calls. |
| `e2e/tasks.spec.ts` *(new)* | see *Verification*. |

## Engine shape

```ts
// tasks.ts — the row. Frozen V1 shape beside the live mapping, per schema.ts's rule.
{
  id, owner,                    // owner scoping is not optional; see below
  agentId, modelChoiceId,       // what runs it, and with which model
  title, instruction,           // what a person sees, and what the model is asked
  kind,                         // "once" | "every"
  spec,                         // "once": an ISO instant. "every": see Schedules.
  tzOffsetMinutes, tzLabel,     // see Traps → time
  nextAt,                       // ms since epoch, as text — the only field the runner queries on
  runningSince,                 // "" or the claim stamp; a stale one is reclaimed
  enabled, failures, pausedReason,
  lastRunAt, lastRunId, lastStatus, lastError, runCount,
  createdAt, updatedAt
}
```

Routes — `@controller("/tasks")`, every one of them owner-scoped through
`callerTags(req)` / `ownerClause` exactly as `/threads` does:

```
GET    /tasks              this owner's tasks, next-to-fire first
POST   /tasks              create; server computes nextAt, never the client
PATCH  /tasks/:id          edit instruction/schedule/enabled; recomputes nextAt
DELETE /tasks/:id
POST   /tasks/:id/run-now  fire immediately; does not disturb nextAt
```

`nextAt` is computed **server-side, always**. A client that sends its own
next-fire time is a client that can schedule a task for every second.

**Guests cannot schedule.** They already run under `GUEST_DAILY_RUNS`; a
scheduler for anonymous callers is an open resource tap. `POST /tasks` from an
untagged caller is a 401, and the console hides the entry rather than drawing a
door that does not open.

### The runner

**Do not put this on a `Worker.run` thread inside the engine, and do not write
an infinite loop.** Both were the first instinct and both are wrong here. The
reasons are recorded in this codebase already:

- **A worker body may not throw.** `Worker.run` takes `() => T` while anything
  touching fs, `JSON.parse`, the database or an HTTP endpoint is typed
  `error{LumenThrow}!T` — read `indexer.ts:5-12`, which is exactly why indexing
  is a process and not a thread. The workaround the sweeper uses is a `try`
  around the *whole* loop, which means **the first throw ends the loop for the
  life of the process**. `sweepLoop` and `digestLoop` can live with that: a
  missed sweep is invisible and the next restart resumes it. A scheduler cannot.
  Provider timeouts are routine, and "the first failed run silently stopped
  every task on the deployment until someone restarted the engine" is the exact
  failure this feature must not have.
- **A long-lived loop is the wrong container for it anyway.** This runtime never
  frees — that is why `joule-engine.service` carries `MemoryMax=2G` and
  `Restart=always`, and why an OOM-killed shell took the engine down for 84
  minutes on 2026-08-01 (the unit file tells that story). A process that runs
  forever holding every transcript it has ever fired is a slow leak with a
  provider bill attached.
- **`setInterval` is not an option regardless**: once `listen` hands over the
  event loop, no timer in that process fires again — verified, not assumed
  (`api.ts:5430`).

So the clock is **systemd** and the work is a **oneshot process**, mirroring the
`indexer` split without inheriting its `while (true)`:

```ini
# joule-scheduler.timer
[Timer]
OnCalendar=*:0/1            # every minute; the minimum task interval is 15
AccuracySec=5s
Persistent=true             # a box that was off does not silently skip the day

# joule-scheduler.service
[Service]
Type=oneshot
ExecStart=…/scheduler       # claims what is due, runs it, exits
MemoryMax=2G
EnvironmentFile=…/.env
```

A process that exits every minute cannot leak, cannot wedge, and cannot take the
engine with it when a provider hangs. systemd will not start a second instance
while one is still running, so a pass that overruns simply skips a tick and the
next one picks up what is due — which is the correct behaviour, not a
compromise. `Persistent=true` is what makes a machine that was asleep run the
missed pass once on boot.

**Reuse the queue module rather than writing one.** `indexing.ts` already has
the atomic claim this needs, in the exact dialect prod runs
(`AGENTS_PG_HOST` — Postgres, so `FOR UPDATE SKIP LOCKED` is real):

- `claimNext` (`indexing.ts:84`) — `UPDATE … WHERE id = (SELECT … LIMIT 1 FOR
  UPDATE SKIP LOCKED) RETURNING …`. Copy this shape verbatim for `claimDue`.
- `requeueStalled` — what a worker that died mid-job needs, and a scheduler
  needs the same thing: a `runningSince` older than the run timeout goes back.
  `indexer.ts` calls it on startup, before anything else. Do the same.
- `markIndexed` / `markFailed` — the completion pair, and the model for
  `markRan` / `markFailed` here.

Firing is **claim → run → complete**, with `next_at` advanced *inside the
claim*:

```sql
UPDATE scheduled_tasks
   SET running_since = ?, next_at = ?
 WHERE id = (SELECT id FROM scheduled_tasks
              WHERE enabled AND running_since = '' AND next_at <= ?
              ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED)
 RETURNING …
```

Advancing on claim is what guarantees a crashed run does not re-fire in a
minute, forever. `SKIP LOCKED` is what lets a second scheduler exist the day one
machine is not enough — and, today, what makes an overlapping tick harmless.

The pass itself: `try` **per task, inside the loop over claimed rows** — the
shape `indexer.ts:56-59` uses deliberately, so one failure costs one task and
the pass carries on. That is the property a whole-body `try` cannot give you and
the main reason this is not a thread.

**Growth path, not v1:** if runs need retries, concurrency across machines, or a
journal the console renders, split it exactly as indexing is split — the
scheduler stops running anything and only *enqueues* a job row when a task comes
due, and a separate runner drains the queue. The claim above is already the hard
half of that.

*Run* is `runAgent(db, agentId, instruction, master)` (`run.ts:262`) — a plain
synchronous call that returns an `AgentRun`. Create the thread first so the
conversation exists in the sidebar before the model starts, then attach the run
to it. Reuse the same path `POST /threads/:id/messages` walks; do not invent a
second way for a turn to happen, or the two will drift and only one will get
the fixes.

*Complete* clears `running_since` and writes `lastRunAt`, `lastRunId`,
`lastStatus`, `runCount`; on failure, `lastError` and `failures + 1`, pausing at
5. A `once` task is marked done.

### Schedules

Keep the grammar small enough to be exhaustively testable and large enough to
express what people actually ask for:

```
every day at HH:MM
every weekday at HH:MM
every <mon|tue|…|sun> at HH:MM
every N hours
every N minutes            (N >= 15)
on <ISO instant>           (kind = "once")
```

Store it in that surface form and parse it in `tasks.ts`. **Do not accept raw
cron.** Nobody writes `0 8 * * 1-5` correctly on the first try, the model will
hallucinate the day-of-week convention (0-Sunday vs 1-Monday differs between
implementations), and a wrong cron string is a silent wrong answer rather than a
parse error. If cron is wanted later it can be a second parser onto the same
row.

`nextFire(spec, tzOffsetMinutes, afterMs) -> ms` must be a **pure function**.
Every interesting bug lives in it and a pure function is the one thing here that
can be tested without a database, a clock, or a network.

## Traps this codebase has already sprung

**Time — already solved; do not hand-roll it.** The runtime has `Date.now()` and
no calendar (`usage.ts:119` hand-rolls a civil-date conversion for one narrow
case), and this was about to be repeated at much larger scale. It should not be:
**`packages/cron` exists and does exactly this job.** It is built, bound and
green — `cd packages/cron && ./build.sh && lumen test cron.test.ts`, 9 tests.

```ts
import { next, civil, offsetMinutes, problem, knownZone } from "../cron/cron.ts";

let fire = next(task.tz, task.cronExpr, Date.now());   // epoch ms, or ok=false
```

It binds ccronexpr (vendored, Apache-2.0, ~1200 lines of C99) for the recurrence
and the system zone database through libc for the zone, so **real IANA zones
work, DST included** — `Europe/Paris` really does move to +02:00 on the last
Sunday in March, and the tests assert it in civil time. The earlier plan here —
store a fixed `tzOffsetMinutes`, accept an 8am task drifting to 9am in summer —
is withdrawn. Store the IANA name, validate it with `knownZone` at the point it
is typed, and let the package answer.

Consequences for the row and the grammar:

- `tzOffsetMinutes` becomes **derived, not stored** — `offsetMinutes(zone, at)`
  when the UI wants to print "08:00 (UTC+2)". A stored offset is what makes a
  task wrong for half the year.
- The friendly grammar **compiles to a six-field cron expression**, and that is
  what the row holds. Cron stays internal and never reaches a person — the "no
  raw cron in the UI" rule above survives intact, while the next-fire maths
  disappears entirely. Mind the dialect: six fields, **seconds first**, so
  `0 8 * * 1-5` is refused rather than silently read as *every eighth second*.
- The DST decisions are already made and asserted in `packages/cron/cron.test.ts`:
  a daily 02:30 task loses one run on the spring-forward day, and fires the first
  of the two 02:30s in autumn. If the product wants the skipped run fired at the
  boundary instead, that belongs in `tasks.ts` — not in a shared package that
  would then be wrong for its other callers.

Two build notes: `packages/cron/build.sh` produces the two `.o` files the FFI
links (no system dependency — the parser is vendored), and the container needs
`tzdata` for `/usr/share/zoneinfo`. The package installs `TZ` for the length of
a call and is therefore **not thread-safe** — which is one more reason the runner
is a single-threaded oneshot process and not a thread inside the engine.

**The chatbot component is off limits.** `nr-chatbot` comes from the vendored
`@nuraly/lumenui` tarball in `app/vendor/`. Do not patch it. Everything the
console needs it does through the component's slots and declared properties —
this rule was set after a patch to the component had to be reverted wholesale.

**`document.querySelector` will not find these elements.** The console lives in
shadow roots. In tests, use the shadow-piercing helpers already in
`e2e/console.ts`. In the app, `this.renderRoot.querySelector(...)`, and remember
that `toggle` and `AnimationEvent` are non-composed — they never leave the root
they fired in, in either phase.

**JSON booleans.** `jsonText` returns `""` for any non-string value, by design.
A boolean read with it is silently lost — this exact bug meant the captcha
`enabled` flag was never stored and a `false` from the plugins form switched
plugins *on*. Use `jsonFlag(doc, key, fallback)` (`scan.ts`) for `enabled`.

**The build must clean first.** `npm run build` runs `rm -rf .lumenjs` and that
is load-bearing — read `app/BUILD.md` before touching the build. Mixed hashed
chunks took the site down for half an hour with every health signal green.

**Backticks in tagged-template comments** break the build. Run
`npm run check:templates` before building; the build script already does.

## Delivery

In-app for v1: the conversation appears, unread, and the sidebar shows a count.
That is the whole notification.

Email is deliberately **out of scope**, and for a concrete reason rather than
timidity: a built LumenJS app currently has no mail path at all — `serve.ts`
never wires `auth.onEvent`, so production sends nothing and `handleForgotPassword`
answers 200 having generated no token. There is already a plan to fix that in
the framework. Scheduled-task email is a small addition *after* it lands, and a
misleading feature before it.

## Verification

- `tasks.test.ts` — table-driven `nextFire`: each grammar form, the 15-minute
  floor, midnight and month-end rollover, a negative offset, a `once` in the
  past (fires immediately, exactly once, then done), and the DST case asserting
  the documented offset behaviour so the decision is pinned by a test.
- `api.test.ts` — create/list/patch/delete under two owners: owner A must not
  see, edit, or delete owner B's task; a guest is refused; a client-supplied
  `nextAt` is ignored; the 11th enabled task is refused.
- Claim safety — two claim attempts against one due row, one wins; a
  `runningSince` older than the timeout is reclaimed by the next pass.
- The runner as a unit — `systemctl start joule-scheduler.service` with one due
  task fires it exactly once and the service reaches `inactive (dead)`,
  `SUCCESS`. A scheduler that stays `activating` is the bug this shape exists to
  prevent, so assert the exit.
- `e2e/tasks.spec.ts` — sign in, create a task for one minute out, wait for the
  conversation to appear with an answer in it, then pause and delete it. Also:
  create through the composer card and assert the *server* has the row, not just
  that the card drew.
- Then the house rule: deploy, drive the deployed page headless, screenshot. A
  200 from `/` and a healthy container are not verification —
  `app/BUILD.md` explains what they failed to catch.

## Non-goals

No cron strings. No per-task tool grants (a task runs as its agent, with that
agent's tools). No sub-minute schedules. No task chaining or dependencies. No
sharing a task with another user. No backfill of missed runs while the engine
was down — on restart, a task whose time has passed fires **once**, not once per
missed interval, and the loop's advance-on-claim is what guarantees it.

## Decide before building

1. **Which agent runs a task** — the one the conversation was created from, or
   an explicit pick at creation time? (Recommend: default to the current one,
   editable, stored on the row — the row must not resolve "default" at fire
   time or a changed default silently rewrites every existing task.)
2. **Where the entry lives** — sidebar rail, or a Settings tab? (Recommend the
   rail: a task is a thing you check, not a preference you set.)
3. **Whether a fired conversation is pinned or ordinary** in the sidebar. The
   product answer differs between ChatGPT and Kimi and it is a taste call.
