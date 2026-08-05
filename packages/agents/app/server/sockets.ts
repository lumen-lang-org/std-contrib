// The live feed, server side.
//
// The console used to ask the engine three questions on three timers, from
// every open tab: what conversations exist (10s), what is this run doing
// (400ms while sending, 2s while watching), and what has this conversation
// saved (4s). Those questions still get asked — the engine is poll-only by
// design and phase 3 does not change that — but they are asked here, once per
// connected browser, over loopback, and the answers are pushed. The browser's
// timers become a fallback for when this feed is not arriving.
//
// What that buys, precisely: the polling leaves the WAN. A tab on a hotel
// wifi no longer spends a round trip every 400ms to learn a tool call
// finished; the server, which is a millisecond from the engine, spends it
// instead and forwards the change. Engine load is unchanged — one poller per
// browser here is one poller per browser there — which is deliberate: phase 3
// is not allowed to regress the engine, and a design that made it cheaper
// would have had to share pollers between sockets.
//
// It does not share them. Sharing means keying a cache by identity, and two
// sockets are two sets of credentials; the key would have to be the whole
// credential or it would be a way for one owner's conversations to land in
// another owner's sidebar. Owner scoping is out of scope for this phase in
// the sense that it must not change, and the cheapest way to guarantee that
// is for every socket to ask the engine with its own browser's headers and
// keep the answer to itself.
//
// No `node:` imports, on purpose. pages/index.ts re-exports `socket` from
// here — that is how LumenJS finds a page's socket handler — and pages/index
// is also a browser module. Anything this file imports is bundled for a page
// that will never call it, so it uses global fetch and touches process.env
// only inside a function body.

import { engineUrl } from "./engine.js";
import { onStream, onWrite } from "./nudge.js";
// How this connection names itself when the browser holds a session cookie
// rather than a header — `AUTH=builtin`. Nothing is installed behind this seam
// in the other two modes, and `credentials()` below is then the whole answer
// exactly as it was.
import { hasIdentityResolver, resolveIdentity } from "./identity.js";

// How often each question is asked when nothing has told this socket to ask.
// The first two are the numbers the client used; the third is faster than the
// client's 10s because it is now a loopback query rather than a WAN round
// trip.
//
// These are the floor under the feed, not its latency. What a change made in
// another browser actually costs is a nudge plus an engine round trip — see
// KICK_GAP_MS and server/nudge.ts. THREADS_MS is what remains when the write
// did not come through this process at all: a second console, a script
// against the API, a title the engine derived on its own. Lowering it to buy
// latency would be paying every socket, every five seconds, forever, for an
// event that happens when a person presses Enter.
const THREADS_MS = 5_000;
const ARTIFACTS_MS = 4_000;
// 140, and it is the cadence, not a fallback — the push design this number
// briefly leaned on is off. The engine nudging per streamed chunk (relay.ts,
// POST /__engine_nudge) read as the right shape and CRASHED THE RUNTIME: a
// synchronous http.request inside the model's streaming callback SIGABRTs
// the Lumen process, reliably, on the first nudge of a turn. The engine-side
// call is reverted; the /__engine_nudge door and noteStream stay, dormant,
// for a runtime that can fire an outbound request from a stream handler.
// Until then this poll is how the answer moves: 140ms is ~7 paints a second,
// under the threshold where updates read as pasted blocks, and it only runs
// at this rate while a turn is streaming for a socket watching it.
const STEPS_RUNNING_MS = 140;
const STEPS_IDLE_MS = 1_500;

// The floor under a nudged question. A kick cancels the pending timer and
// asks now, so without a gap a client holding down a mutating endpoint would
// multiply into one engine query per write per open socket — the socket layer
// turned into an amplifier, which is the one thing phase 3 promised the engine
// it would not become.
//
// A single write, which is the case that matters, pays none of this: the loop
// is idle, `lastAsk` is seconds old, and the question goes out immediately. It
// is only a burst that gets spread, to at most two threads queries a second
// per socket, with the last write in the burst always answered.
const KICK_GAP_MS = 500;

// The liveness signal, and the only reason there is a message on an idle
// connection at all.
//
// The client cannot see this socket: LumenJS's router owns it and hands the
// page only the pushes. So "is the feed up" is answered the way it is
// answered on the wire — by something arriving on time. Two seconds of beat
// against a six-second window in src/live.ts means a feed that dies mid-run
// falls back to polling within six seconds. Socket.IO's own disconnect
// detection is slower than that (15s ping, 10s timeout, so up to 25s), which
// is why this exists rather than a `disconnect` listener.
const BEAT_MS = 2_000;

/** What a browser is told. One property, so LumenJS's router spreads exactly
 *  one thing onto the page element and src/live.ts fans it out from there. */
type Feed =
  | { kind: "hello" }
  | { kind: "beat" }
  | { kind: "threads"; threads: unknown }
  | { kind: "round"; threadId: string; round: unknown }
  | { kind: "artifacts"; threadId: string; artifacts: unknown };

/** The headers that say who is asking.
 *
 *  Exactly the identity-bearing ones, and nothing invented: api-proxy.ts
 *  forwards the browser's request headers untouched and adds no token of its
 *  own, so this poller must reach the engine as the same caller the browser's
 *  own fetches reach it as. Adding a credential here that the proxy does not
 *  add would mean the socket could see conversations the page cannot. */
function credentials(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { accept: "application/json" };
  for (const name of ["cookie", "x-user", "authorization"]) {
    const value = headers[name];
    if (typeof value === "string" && value !== "") out[name] = value;
  }
  return out;
}

interface Ctx {
  on: (event: string, handler: (...args: any[]) => void) => void;
  push: (data: unknown) => void;
  headers: Record<string, unknown>;
}

export function socket(ctx: Ctx) {
  const inbound = credentials(ctx.headers);
  const send = (live: Feed) => ctx.push({ live });

  /** The headers for one engine question.
   *
   *  With no resolver installed — `AUTH=none` and `AUTH=proxy` — this is
   *  `inbound` unchanged: the
   *  handshake's own cookie, `X-USER` and `authorization`, which is what this
   *  poller sent before phase 4 and what api-proxy.ts still forwards.
   *
   *  With one installed — `AUTH=builtin` — the app owns the header. The
   *  browser reached this server with a session cookie and no `X-USER`, and
   *  the poller must arrive at the engine as the same caller the page's own
   *  fetches do, which is a caller the middleware stamped. The inbound copy is
   *  dropped rather than merged, because in that mode an `X-USER` on the
   *  handshake is one the browser chose for itself.
   *
   *  Asked per question rather than once per connection. A socket can be open
   *  all day; a session it holds can be signed out from another tab, and the
   *  feed should stop at the next tick rather than at the next reload. It
   *  costs one AES-GCM open and, if the session is a browser one, a point
   *  query against the app's own database. */
  async function asking(): Promise<Record<string, string>> {
    if (!hasIdentityResolver()) return inbound;
    const document = await resolveIdentity(ctx.headers);
    const out = { ...inbound };
    delete out["x-user"];
    if (document !== "") out["x-user"] = document;
    return out;
  }

  // Which conversation this browser is looking at. "" is the home screen,
  // where there is no run to watch and nothing saved to list.
  let watching = "";

  // The last body each question answered with, verbatim. Change detection is
  // string equality on the response text rather than a diff of the parsed
  // shape: the engine answers these in a stable order, the comparison cannot
  // disagree with itself about key order or number formatting, and a push
  // that says nothing is a push the client has to think about.
  let lastThreads = "";
  let lastRound = "";
  let lastArtifacts = "";

  let stopped = false;
  const cancels: (() => void)[] = [];

  /** Ask on a timer that only re-arms once the answer is in. A setInterval
   *  against an engine slower than the interval queues requests behind each
   *  other until neither the console nor the engine is doing anything else.
   *
   *  Each loop holds one handle, replaced on every tick rather than collected:
   *  a set of every timer ever armed would grow by nine thousand entries an
   *  hour on the fast one, for a socket that may be open all day. `arm` is the
   *  only place a handle is set, and it clears the old one first, so a kick
   *  arriving next to a scheduled tick replaces it instead of racing it.
   *
   *  Returns the way to say "ask now" — see `kick`. */
  function loop(delay: () => number, tick: () => Promise<void>): { kick: () => void } {
    let handle: ReturnType<typeof setTimeout> | null = null;
    // Whether a question is currently outstanding, and when the last one went
    // out. Both exist for `kick` alone; the timer path needs neither.
    let asking = false;
    let again = false;
    let lastAsk = 0;

    const arm = (ms: number) => {
      if (handle !== null) clearTimeout(handle);
      handle = setTimeout(run, ms);
    };

    const run = async () => {
      handle = null;
      if (stopped) return;
      asking = true;
      lastAsk = Date.now();
      try { await tick(); } catch { /* the next tick asks again */ }
      asking = false;
      if (stopped) return;
      // A write landed while this answer was in flight. That answer was asked
      // for before the write and cannot contain it, so the loop owes one more
      // question — at the gap, not immediately, or a write per answer would
      // hold the loop at full speed for as long as the writing lasted.
      if (again) { again = false; arm(KICK_GAP_MS); return; }
      arm(delay());
    };

    /** Something changed; do not wait for the tick. Idle and rested, this asks
     *  on the next turn of the event loop. Mid-question, it is remembered and
     *  asked on the way out. Recently asked, it waits out KICK_GAP_MS. */
    const kick = () => {
      if (stopped) return;
      if (asking) { again = true; return; }
      arm(Math.max(0, lastAsk + KICK_GAP_MS - Date.now()));
    };

    cancels.push(() => { if (handle !== null) clearTimeout(handle); });
    void run();
    return { kick };
  }

  async function ask(path: string): Promise<string | null> {
    const res = await fetch(engineUrl(path), { headers: await asking() });
    // A 401 is the engine saying this browser may not ask. Nothing is pushed
    // and nothing is remembered — the page's own fetches get the same answer
    // and api.ts already knows what to do with it.
    if (!res.ok) return null;
    return res.text();
  }

  // --- what conversations exist ---------------------------------------------
  //
  // The same query the sidebar used to make. A title is derived server-side
  // from the first thing said in a conversation, so a conversation that gets
  // its first message in one tab acquires a title in every other tab's
  // sidebar here, without any of them refetching anything — backlog #28's
  // console half.
  const threads = loop(() => THREADS_MS, async () => {
    const body = await ask("/threads?limit=50");
    if (body === null || body === lastThreads) return;
    lastThreads = body;
    send({ kind: "threads", threads: JSON.parse(body) });
  });

  // --- what the watched run is doing ----------------------------------------
  //
  // Fast while a round is running and slow otherwise, which is the same two
  // cadences the client ran: its 400ms watcher during its own send and its 2s
  // follower the rest of the time. Here one loop covers both, because the
  // answer itself says which is wanted.
  let running = false;
  const steps = loop(() => (running ? STEPS_RUNNING_MS : STEPS_IDLE_MS), async () => {
    if (watching === "") { running = false; return; }
    const id = watching;
    const body = await ask(`/threads/${encodeURIComponent(id)}/steps`);
    // The thread changed under us while the answer was in flight; that answer
    // is about a conversation nobody is looking at any more.
    if (body === null || id !== watching) return;
    const round = JSON.parse(body) as { running?: boolean };
    running = round.running === true;
    if (body === lastRound) return;
    lastRound = body;
    send({ kind: "round", threadId: id, round });
  });

  // --- what the watched conversation has saved ------------------------------
  loop(() => ARTIFACTS_MS, async () => {
    if (watching === "") return;
    const id = watching;
    const body = await ask(`/threads/${encodeURIComponent(id)}/artifacts`);
    if (body === null || id !== watching || body === lastArtifacts) return;
    lastArtifacts = body;
    send({ kind: "artifacts", threadId: id, artifacts: JSON.parse(body) });
  });

  loop(() => BEAT_MS, async () => { send({ kind: "beat" }); });

  // A mutation went through this server's proxy, from some browser — usually
  // not this one. Ask the thread question now instead of at the next tick;
  // that is what turns "another browser's conversation appears in this
  // sidebar within five seconds" into "within an engine round trip", without
  // asking the engine anything more often on an idle console.
  //
  // Nothing about the write is known here and nothing is taken on trust: the
  // question that follows is the same question, with this browser's own
  // credentials, and it pushes only if the answer moved. A nudge caused by an
  // owner this socket knows nothing about produces an unchanged body and no
  // push at all. See server/nudge.ts.
  //
  // Only the thread list is kicked. It is the one answer shared between
  // browsers; the run and the artifact list describe the conversation this
  // browser is watching, which is the browser doing the writing, and their
  // loops already run at 400ms and 4s for it.
  cancels.push(onWrite(() => threads.kick()));
  // The engine's chunk nudge. This is what makes the streamed answer arrive
  // at the model's cadence rather than the timer's — the timer above is the
  // fallback, at its own rate, exactly as the write nudge's rules require.
  cancels.push(onStream(() => steps.kick()));

  // The browser says which conversation it is looking at. Everything watched
  // is forgotten on the way, so the first answer about the new one is always
  // pushed rather than compared against the old one's.
  ctx.on("watch", (data: unknown) => {
    const id = typeof (data as { threadId?: unknown })?.threadId === "string"
      ? (data as { threadId: string }).threadId : "";
    if (id === watching) return;
    watching = id;
    lastRound = "";
    lastArtifacts = "";
    running = false;
  });

  // Said once, on connect. A socket that reconnects gets a fresh handler with
  // an empty `watching`, and the browser has no other way to notice that: this
  // is its cue to say again which conversation it is looking at.
  send({ kind: "hello" });

  return () => {
    stopped = true;
    for (const cancel of cancels) cancel();
    cancels.length = 0;
  };
}
