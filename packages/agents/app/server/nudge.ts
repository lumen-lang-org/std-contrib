// The write path telling the feed not to wait for its next tick.
//
// server/api-proxy.ts sees every mutation a browser makes; server/sockets.ts
// asks the engine, on a timer, on behalf of every *other* browser. With no
// word between them a conversation created in one tab reaches another tab's
// sidebar only when that tab's socket next happens to ask — anywhere up to
// THREADS_MS late, which measured 3.4s in e2e/live-fanout.spec.ts against a
// 2s budget. Discovery by timer is the defect; this is the word.
//
// What crosses is a bare "something was written". No thread id, no body, no
// identity, no answer. Each socket still asks the engine with its own
// browser's credentials and still pushes only when its own answer changed, so
// a write by one owner cannot put a row in another owner's sidebar — it can
// only make that owner's socket ask, sooner, a question it was going to ask
// anyway. That is the property that makes a signal safe to broadcast to every
// connected socket, and it is precisely why the signal carries nothing. Give
// it a payload and the fan-out becomes a way to move one owner's data to
// another, which is the thing phase 3 is not allowed to do.
//
// It is an accelerator, never a mechanism. The timers in sockets.ts are not
// cancelled or lengthened, for the same reason the client's pollers were not:
// a write that never passes through this process — a second console, a script
// against the API, the engine's own titling — still has to land, and the only
// thing that guarantees it is the tick. Same rule as app/CLAUDE.md's, one
// layer down.
//
// --- why globalThis --------------------------------------------------------
//
// Not paranoia about ESM. The two callers are loaded through two different
// module graphs, and only one of them is Vite's. In `lumenjs dev` both
// lumenjs.server.js (the proxy) and pages/index.ts (the socket) go through
// server.ssrLoadModule and would share this module's scope. Under
// `lumenjs serve` the page is a Rollup bundle in .lumenjs/server with
// sockets.ts inlined into it, while lumenjs.server.js is compiled beside it —
// two bundles, two copies of this file, and a nudge that lands in an empty
// set. A registry that works in dev and quietly does nothing in the shipped
// image is worse than no registry at all, because the e2e that proves it runs
// against dev.
//
// A framework-level handle on the Socket.IO namespace from outside a
// connection would retire this. LumenJS offers none today — `room.broadcast`
// exists only on the per-connection ctx — and that is the note in
// MIGRATION-LUMENJS.md's small-patches budget, not a blocker here.
//
// No `node:` imports, for the reason server/engine.ts has none: sockets.ts
// imports this file, and sockets.ts is bundled for the browser through
// pages/index.ts's `export { socket }`.

type Listener = () => void;

// Versioned, because two copies of this file with the same key and different
// ideas about what a listener is would be worse than two registries.
const KEY = "__agentsConsoleWriteNudgeV1__";

function listeners(): Set<Listener> {
  const scope = globalThis as unknown as Record<string, unknown>;
  const found = scope[KEY];
  if (found instanceof Set) return found as Set<Listener>;
  const made = new Set<Listener>();
  scope[KEY] = made;
  return made;
}

/** A socket asks to be told. Returns the unsubscribe, which its disconnect
 *  cleanup must call: this set outlives every socket in it, so a listener left
 *  behind is a closure — and its whole poller — kept alive for the life of the
 *  process, once per browser that ever connected. */
export function onWrite(fn: Listener): () => void {
  const set = listeners();
  set.add(fn);
  return () => { set.delete(fn); };
}

/** The proxy says a mutation went through. Copied before iterating so a
 *  listener that unsubscribes on the way — a socket disconnecting in the same
 *  tick — cannot make the loop skip its neighbour, and never throws: the
 *  request that triggered this is already being answered and must not fail
 *  because a socket's poller did. */
export function noteWrite(): void {
  for (const fn of [...listeners()]) {
    try { fn(); } catch { /* one socket's problem, not the writer's */ }
  }
}

// --- the stream channel ------------------------------------------------------
//
// The same signal with a different trigger. `noteWrite` is the proxy seeing a
// browser's mutation; `noteStream` is the ENGINE saying a streamed chunk just
// landed — it POSTs /__engine_nudge (server/api-proxy.ts) from its own
// streaming callback, so the cadence of the reply on screen is the cadence of
// the model, not of a timer. Everything the header says about the write nudge
// holds here unchanged: it carries nothing, each socket re-asks with its own
// credentials, and the steps timer in sockets.ts stays as the fallback for a
// chunk whose nudge never arrived.

const STREAM_KEY = "__agentsConsoleStreamNudgeV1__";

function streamListeners(): Set<Listener> {
  const scope = globalThis as unknown as Record<string, unknown>;
  const found = scope[STREAM_KEY];
  if (found instanceof Set) return found as Set<Listener>;
  const made = new Set<Listener>();
  scope[STREAM_KEY] = made;
  return made;
}

export function onStream(fn: Listener): () => void {
  const set = streamListeners();
  set.add(fn);
  return () => { set.delete(fn); };
}

export function noteStream(): void {
  for (const fn of [...streamListeners()]) {
    try { fn(); } catch { /* a broken socket must not break its neighbours */ }
  }
}
