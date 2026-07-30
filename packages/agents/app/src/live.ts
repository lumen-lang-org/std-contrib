// The live feed, browser side.
//
// Not a transport. The socket belongs to LumenJS's router, which opens it for
// any page that exports a `socket()` handler, spreads whatever the server
// pushes onto the page element's properties, and hands that element an
// `emit`. pages/index.ts owns those two seams and passes both through here;
// the console's regions read the feed from this module and never learn that a
// socket exists.
//
// Which is also the fallback mechanism, and the reason it is not a mechanism.
// With no router, no page element or no socket — a server that serves none, a
// browser that could not open one — nothing is ever delivered, `fresh()` is
// permanently false, and the three pollers this feed exists to replace run
// exactly as they always did. The
// same is true of a socket that dies at any point: the beat stops arriving,
// `fresh()` goes false within seconds, and the timers — which were never
// cancelled, only made to return early — start doing the work again. There is
// no reconnect logic here because there is nothing to reconnect: the fallback
// is the disconnected state.

import type { ArtifactListing, RoundSteps, ThreadListing } from "./api.js";

/** One push, as server/sockets.ts writes it. */
export type Feed =
  | { kind: "hello" }
  | { kind: "beat" }
  | { kind: "threads"; threads: ThreadListing[] }
  | { kind: "round"; threadId: string; round: RoundSteps }
  | { kind: "artifacts"; threadId: string; artifacts: ArtifactListing[] };

type Kind = Feed["kind"];
type Of<K extends Kind> = Extract<Feed, { kind: K }>;

// How long a delivery keeps the feed "fresh". The server beats every 2s, so
// this is three missed beats — long enough that a slow tick or a garbage
// collection pause does not flap a poller on and off, short enough that a
// feed which really has stopped is noticed before a person is.
const FRESH_MS = 6_000;

let lastAt = 0;
let emitter: ((event: string, payload?: unknown) => void) | null = null;
let watched = "";

const listeners = new Map<Kind, Set<(payload: never) => void>>();

/** Whether the feed is arriving. False before the first push, false a few
 *  seconds after the socket stops. Every fallback poll in
 *  the console is one `if (fresh()) return;` away from being skipped. */
export function fresh(): boolean {
  return Date.now() - lastAt < FRESH_MS;
}

/** The page element hands over what LumenJS's router pushed onto it. */
export function deliver(payload: unknown): void {
  const feed = payload as Feed | null;
  if (feed === null || typeof feed !== "object" || typeof feed.kind !== "string") return;
  lastAt = Date.now();
  // A reconnected socket is a new handler on the server with no idea which
  // conversation this browser is looking at. `hello` is when to say so again.
  if (feed.kind === "hello") { tell(); return; }
  if (feed.kind === "beat") return;
  for (const fn of listeners.get(feed.kind) ?? []) {
    // One listener that throws must not cost the others their payload.
    try { (fn as (p: Feed) => void)(feed); } catch { /* not the feed's problem */ }
  }
}

/** The page element hands over the router's injected emit. */
export function setEmit(fn: ((event: string, payload?: unknown) => void) | null): void {
  emitter = fn;
  // It arrives after the socket connects, which can be after the console has
  // already opened a conversation. Say what is being watched as soon as there
  // is something to say it with.
  tell();
}

/** Say which conversation this browser is looking at. "" is the home screen. */
export function watch(threadId: string): void {
  if (threadId === watched) return;
  watched = threadId;
  tell();
}

function tell(): void {
  if (emitter === null) return;
  try { emitter("watch", { threadId: watched }); } catch { /* the next hello retries */ }
}

/** Listen for one kind of push. Returns the unsubscribe. */
export function on<K extends Kind>(kind: K, fn: (payload: Of<K>) => void): () => void {
  const set = listeners.get(kind) ?? new Set();
  set.add(fn as (payload: never) => void);
  listeners.set(kind, set);
  return () => { set.delete(fn as (payload: never) => void); };
}
