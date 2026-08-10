// cron -- when does this run next, in a real timezone.
//
// The thing a scheduler is actually made of. Answering "the next weekday at
// 08:00 in Europe/Paris, in epoch milliseconds" needs two capabilities this
// runtime does not have: a recurrence parser, and a zone database that knows
// Paris moved to +02:00 on the last Sunday in March. Both exist in C and are
// decades old, so this package binds them rather than reimplementing them —
// see README.md for why that call went this way.
//
// Build the objects first:
//   ./build.sh
//
// @link ./cron_shim.o
// @link ./ccronexpr.o
// @link c

// Six fields: second minute hour day-of-month month day-of-week. Seconds
// first is Spring's dialect, which is what ccronexpr implements — a five-field
// expression is refused rather than guessed at, because guessing turns
// "0 8 * * 1-5" into "every 8th second".
declare function cron_error(expr: string): string;
declare function cron_next_ms(zone: string, expr: string, afterMs: i64): i64;
declare function cron_prev_ms(zone: string, expr: string, beforeMs: i64): i64;
declare function cron_format_ms(zone: string, atMs: i64): string;
declare function cron_offset_minutes(zone: string, atMs: i64): int;
declare function cron_zone_known(zone: string): int;

// A schedule that could not be read, and why. `at` is -1 whenever `ok` is
// false, so a caller that ignores `ok` still cannot mistake the answer for a
// time.
export type Fire = {
  ok: bool,
  at: i64,
  error: string,
};

// "" if `expr` is a schedule this can compute, otherwise the parser's
// complaint — which names the offending field. Check this at the point a
// person types an expression, not at the point it should fire: a schedule that
// fails to parse in the runner is a task that silently never runs.
export function fault(expr: string): string {
  return cron_error(expr);
}

// Whether this machine's zone database has heard of `zone`. Worth calling
// before storing a zone on a row: glibc answers an unknown name with UTC
// rather than an error, so an unchecked typo becomes a task that runs at the
// right time in the wrong place and looks correct from every angle.
export function knownZone(zone: string): bool {
  return cron_zone_known(zone) == 1;
}

// The first firing strictly after `afterMs`, in `zone`.
//
// Two DST cases decide themselves here, and both are worth knowing before
// relying on this:
//
//   spring forward — 02:30 does not exist on the day the clocks jump, and this
//     answers the next day rather than firing at 03:30. A daily task loses one
//     run a year.
//   fall back — 02:30 happens twice, and this answers the first.
//
// Neither is arbitrary and neither is universal: other schedulers fire the
// skipped run at the boundary instead. If that is wanted, it belongs in the
// caller, where the product decision lives — not in a shared package that
// would then be wrong for the other half of its callers.
export function next(zone: string, expr: string, afterMs: i64): Fire {
  let complaint = cron_error(expr);
  if (complaint != "") {
    let bad: Fire = { ok: false, at: -1, error: complaint };
    return bad;
  }
  let at = cron_next_ms(zone, expr, afterMs);
  if (at < 0) {
    let none: Fire = { ok: false, at: -1, error: "\"" + expr + "\" has no next firing" };
    return none;
  }
  let fire: Fire = { ok: true, at: at, error: "" };
  return fire;
}

// The most recent firing at or before `beforeMs` — how a process that was down
// decides whether it missed one, and what to say about it.
export function previous(zone: string, expr: string, beforeMs: i64): Fire {
  let complaint = cron_error(expr);
  if (complaint != "") {
    let bad: Fire = { ok: false, at: -1, error: complaint };
    return bad;
  }
  let at = cron_prev_ms(zone, expr, beforeMs);
  if (at < 0) {
    let none: Fire = { ok: false, at: -1, error: "\"" + expr + "\" has no previous firing" };
    return none;
  }
  let fire: Fire = { ok: true, at: at, error: "" };
  return fire;
}

// An instant as civil time where a person lives: "2026-03-30 08:00:00 CEST".
export function civil(zone: string, atMs: i64): string {
  return cron_format_ms(zone, atMs);
}

// The zone's offset from UTC at that instant, in minutes — 120 for Paris in
// summer, -300 for New York in winter, 330 for Kolkata always.
export function offsetMinutes(zone: string, atMs: i64): int {
  return cron_offset_minutes(zone, atMs);
}
