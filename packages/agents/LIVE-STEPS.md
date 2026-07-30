# Live tool and agent status in the console

What a person watching a slow answer should see: which tool is running now, how
many have finished, and how long each took. Today they see a spinner and then a
finished message, because `POST /threads/:id/messages` answers once, at the end,
and the only step information that ever reaches the console is
`toolCalls: number` in `SayReply`.

The target, from the reference screens:

- while the round runs — a line reading `Calling callAgent…`, and a card
  headed `Outils en cours` with one row per call: the tool name in monospace,
  a preview of its arguments, a spinner per row
- when it finishes — the same card, collapsed to `1 outil exécuté` with a check
  and a duration per row (`10287ms`), sitting above the answer and staying there

## The transport, and why

Three ways to get progress out of a run that is still going:

**Stream the reply.** Rejected: `Reply` in `rest/server.ts` is a whole body —
status, body, content type, headers — and the handler returns it once. The
runtime does know `Transfer-Encoding: chunked`, but on the client reader and a
different server path; a streaming *reply* would need a change to the language's
HTTP server. House rule 6 says write that up rather than work around it, and it
is written up here.

**A websocket.** `packages/websocket` has a working server, and the console
already depends on `socket.io-client`. But nothing in `agents` runs one, so it
needs a thread, a lifecycle, a reconnect story and a second port to expose —
and the steps still have to be published to *something* the socket can read.

**Publish to a table, poll it.** Taken. The run loop already holds the `Db` —
`runAgent(db, agentId, userText, master)` — and `RunContext` already carries
`threadId`. So the loop can write a row when a call starts and update it when
the call ends, with no plumbing at all. The console polls while a message is in
flight.

The deciding fact, checked rather than assumed: the language's HTTP server runs
handlers on a real `xev.ThreadPool` sized to the CPU count
(`lumen_runtime_net.zig:384-414`), so a `GET` **is** answered while a `POST` is
still running. Without that this design would not work at all.

Publishing first is also what makes the transport swappable: when a socket
server arrives it reads the same rows and pushes them, and none of the run-loop
work is redone.

## The data

    thread_steps
      thread_id    text     the thread
      seq          int      the round, so a step is attached to one message
      idx          int      order within the round
      kind         text     "tool" | "agent" | "artifact" | "workspace"
      name         text     the tool or the child agent's name
      target       text     which MCP server answered, or the child's id
      args         text     a preview, capped — never the whole argument JSON
      started_at   text     stamp() when dispatch begins
      ended_at     text     "" while running, stamp() when it returns
      ok           bool     meaningful only once ended_at is set

`ended_at == ""` is the whole liveness signal: a row with one is finished, a row
without one is what draws a spinner. Duration is the difference, computed by the
reader, so the writer never has to hold a clock across a call that may throw.

Capping `args` matters: an argument list can be a whole file, and this row is
read on a timer.

## Where it is written

`run.ts`, the dispatch loop at 497. The two points already exist and are already
where the trace span opens and closes:

    let callSpan = startSpan(calls[i].name, TRACE_TOOL, agentSpan.id);   // → write the row
    …dispatch: child, artifact, workspace or MCP…
    …result known…                                                       // → close the row

Which means the liveness rows and the trace spans cannot disagree about what ran.

## Where it is read

`GET /threads/:id/steps?since=<seq>` — the round's steps, newest round by
default. Cheap enough to poll: one indexed read on `(thread_id, seq)`.

## The migration

Next free version is **55**; 54 is the `thread_turns` unique index, and the
high-water rule refuses anything below the mark. It must be generated from a
**frozen** mapping copy — `threadStepsMappingV1()` — per REVIEW-FIXES.md P2:
migrations built from a live mapping rewrite their own recorded SQL the next
time a field is added, and every deployed database then refuses the whole plan.

## The console

`chat-session.ts` owns the send. While `say()` is outstanding it polls
`/threads/:id/steps` and pushes the rows into the state object the controller
already renders from — one stable object, not a fresh array per tick, because a
fresh one pegged the tab once already.

The card renders from the rows alone:

- any row with `ended_at == ""` → the running form, `Outils en cours`
- otherwise → `N outils exécutés`, a check per row, `ended_at - started_at` in ms
- the heading counts rows, so a round with three calls says three

No emoji. `nr-icon` for the check and the spinner, and the names must exist —
`check` does, and the spinner is whatever `nr-chatbot` already uses for its own
pending state rather than a second vocabulary.

## Order of work

1. `thread_steps` + migration 55 + the frozen mapping — nothing else can be
   tested until a row can exist.
2. The two writes in the dispatch loop, with a test that runs a tool and asserts
   a row exists with no `ended_at` while it is in flight.
3. The read route, with a test that polls it during a run.
4. The console: poll, state, card.
5. An e2e test that drives the UI and sees the card appear and then collapse —
   the suite's rule is that a test types into the composer and reads what
   appears, so this one waits for `Outils en cours` and then for the check.
