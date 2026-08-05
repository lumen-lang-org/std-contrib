// Telling the console a streamed chunk landed.
//
// The console serves the browser a live feed, and until this existed the feed
// learned about a streaming answer by asking this process on a timer — the
// reply arrived on screen in poll-sized slabs, which a person described,
// accurately, as "block by block, not stream by stream". The model's own
// rhythm was in this process the whole time: the streaming callback in run.ts
// fires per chunk. This module is that rhythm, forwarded.
//
// The signal carries NOTHING — no thread id, no text, no identity. It is the
// same contract as the console's write nudge (app/server/nudge.ts, whose
// header explains why at length): every socket that hears it re-asks the
// engine with its own credentials and pushes only what changed, so a nudge
// can accelerate a feed but can never move one owner's data into another's.
// That property is what makes it safe to fire at every console on the box
// without knowing who is watching what.
//
// AGENTS_CONSOLE_NUDGE is a comma-separated list of URLs, because this box
// runs two consoles (the dev host's source server and joule.sh's container)
// and both serve live feeds. Unset means off, and off means the consoles fall
// back to the polling they had — the nudge is an accelerator, never a
// mechanism, on this side of the wire as well as theirs.

/** The last nudge's clock, for the throttle. A chunk can be a handful of
 *  tokens, and a nudge per chunk at 100 tokens a second would be a POST storm
 *  that outruns what any screen can show. 80ms keeps it ahead of the client's
 *  own 50ms paint coalescer — nudging faster than the renderer paints buys
 *  nothing. */
let lastNudge: number = 0;

/** Backoff until this clock when a console refused or was unreachable. The
 *  request is synchronous inside the model's streaming callback, so a console
 *  that is down must cost one failed connect per cooloff window, not one per
 *  chunk — that would be the streaming stall this module exists to remove. */
let coolUntil: number = 0;

const NUDGE_GAP_MS: number = 80;
const COOLOFF_MS: number = 30000;

export function nudgeConsoles(): void {
  let targets = process.env("AGENTS_CONSOLE_NUDGE") ?? "";
  if (targets == "") { return; }
  let now = Date.now();
  if (now < coolUntil) { return; }
  if (now - lastNudge < NUDGE_GAP_MS) { return; }
  lastNudge = now;

  let list = targets.split(",");
  let failed = false;
  let i: int = 0;
  while (i < list.length) {
    let url = list[i].trim();
    if (url != "") {
      let res = http.request(url, "POST", "", new Map<string, string>());
      if (!res.ok || res.status != 204) { failed = true; }
    }
    i = i + 1;
  }
  // One console down cools both off. Finer bookkeeping would be per-target
  // state for a failure mode — half the consoles dead — that this box does
  // not have; the fallback poll covers whoever missed out.
  if (failed) { coolUntil = now + COOLOFF_MS; }
}
