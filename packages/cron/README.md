# cron

When does this run next, in a real timezone.

```ts
import { next, previous, civil, offsetMinutes, problem, knownZone } from "./cron.ts";

let fire = next("Europe/Paris", "0 0 8 * * 1-5", Date.now());
console.log(civil("Europe/Paris", fire.at));   // 2026-03-30 08:00:00 CEST
```

Build the objects once before using it — there is no system dependency, the
parser is vendored here:

```sh
./build.sh
```

## The surface

| | |
| --- | --- |
| `next(zone, expr, afterMs) -> Fire` | the first firing strictly after `afterMs` |
| `previous(zone, expr, beforeMs) -> Fire` | the most recent firing at or before `beforeMs` |
| `problem(expr) -> string` | `""` if the expression parses, else why not |
| `knownZone(zone) -> bool` | whether this machine's zone database has it |
| `civil(zone, atMs) -> string` | `"2026-03-30 08:00:00 CEST"` |
| `offsetMinutes(zone, atMs) -> int` | `120` for Paris in summer, `330` for Kolkata |

`Fire` is `{ ok, at, error }`, and `at` is `-1` whenever `ok` is false — so
code that forgets to check `ok` still cannot mistake the answer for a time.

Times are **epoch milliseconds**, matching `Date.now()`. Expressions are **six
fields** — `second minute hour day-of-month month day-of-week` — which is the
Spring dialect. A five-field expression is refused rather than guessed at,
because read as six, `0 8 * * 1-5` means *every eighth second*.

## Why this is a binding and not Lumen

Two things are needed to answer "the next weekday at 08:00 in Paris": a
recurrence parser, and the knowledge that Paris moves to UTC+02:00 on the last
Sunday in March.

The first is a fair amount of fiddly code and no research. The second is not
code at all — it is the IANA time zone database, a body of legislative fact
about every jurisdiction on earth that changes several times a year, that no
program can derive and every program must be told. Reimplementing the parser in
Lumen would be a weekend; shipping a zone database would be a subscription.

So this binds:

- **[ccronexpr](https://github.com/staticlibs/ccronexpr)** (Apache-2.0, ~1200
  lines of C99, vendored here as `ccronexpr.c` / `ccronexpr.h`, unmodified) for
  the recurrence maths.
- **the system zone database** through libc — `/usr/share/zoneinfo`, present on
  every Linux and in any container that installs `tzdata`. `cron_shim.c`
  installs the zone for the length of a call and puts back whatever was there.

`ccronexpr.c` keeps its own copyright header. Its Apache-2.0 licence permits
redistribution in source form; this package's own code is under the repository
licence.

## What it does not do

- **No timers, no threads, no loop.** This answers *when*, and returns. What to
  do at that time, and what keeps time, belong to the caller — a systemd timer,
  a queue worker, a test that passes a fixed instant.
- **Not thread-safe.** The zone is process state (`TZ` plus `tzset`), so two
  threads asking about two zones at once will interfere. The intended caller is
  a single-threaded process. If that ever stops being true, the fix is not a
  mutex — it is vendoring IANA tzcode for `tzalloc`/`mktime_z`, which take the
  zone as a handle rather than as global state.
- **No opinion about daylight saving.** It reports what the rules say. When the
  clocks go forward, an 02:30 daily task finds that 02:30 does not exist and
  answers the next day — one lost run a year. When they go back it answers the
  first of the two 02:30s. Both are asserted in `cron.test.ts` so that changing
  them is deliberate. A scheduler that would rather fire at the boundary should
  do that in its own code, where the product decision belongs.

## Tests

```sh
./build.sh && lumen test cron.test.ts
```

Every assertion is written in civil time, never in epoch milliseconds — a
failure reading `expected 1774850400000, got 1774846800000` tells you nothing,
and this package exists to get exactly that one hour right.
