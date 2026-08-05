// The half of a scheduler that can be tested without a clock or a database:
// what a person's words compile to, when that fires, and what is refused.
//
//   cd packages/agents && ../cron/build.sh && lumen test tasks.test.ts
//
// Firing times are asserted in civil time through `packages/cron`, never in
// epoch milliseconds — an assertion that reads "expected 1774850400000" tells
// a reader nothing, and every interesting bug in a scheduler is one hour wide.

import { compile, isOnce, nextFire, onceInstant, refuse, stampMs, TaskRow, MIN_EVERY_MINUTES } from "./tasks.ts";
import { civil } from "../cron/cron.ts";

// Saturday 2026-03-28T12:00:00Z — a weekend, so day-of-week arithmetic has to
// skip Sunday, and two days before Europe's spring-forward.
const SAT: number = 1774699200000;

// Records are immutable here, so a fixture is built whole rather than poked at
// field by field. `what` and `who` are the two things the refusal tests vary.
function task(kind: string, expr: string, tz: string, at: string, who: string, what: string): TaskRow {
  let row: TaskRow = {
    id: "t1", owner: "o1", agentId: who, modelChoiceId: "",
    title: "", instruction: what,
    kind: kind, cronExpr: expr, tz: tz, nextAt: at, runningSince: "",
    enabled: true, failures: 0, pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: 0, createdAt: "", updatedAt: "",
  };
  return row;
}

function every(expr: string, tz: string): TaskRow {
  return task("every", expr, tz, "", "a1", "summarise the day");
}

test("the words people actually use compile to a schedule", () => {
  expect(compile("every weekday at 08:00").expr == "0 0 8 * * 1-5");
  expect(compile("every day at 07:30").expr == "0 30 7 * * *");
  expect(compile("every monday at 09:15").expr == "0 15 9 * * 1");
  expect(compile("every sun at 23:59").expr == "0 59 23 * * 0");
  expect(compile("every weekend at 10:00").expr == "0 0 10 * * 0,6");
  expect(compile("every 30 minutes").expr == "0 */30 * * * *");
  expect(compile("every 6 hours").expr == "0 0 */6 * * *");

  // Case and stray spacing are a typing accident, not a different request.
  expect(compile("  EVERY   Weekday   at   08:00  ").expr == "0 0 8 * * 1-5");
});

test("what is refused, and with a sentence rather than a code", () => {
  expect(!compile("every 5 minutes").ok);                      // under the floor
  expect(compile("every 5 minutes").error.indexOf(`${MIN_EVERY_MINUTES}`) >= 0);
  expect(!compile("at 8").ok);                                 // no "every"
  expect(!compile("every fortnight at 08:00").ok);
  expect(!compile("every day at 8").ok);                       // HH:MM, not H
  expect(!compile("every day at 25:00").ok);
  expect(!compile("every 0 hours").ok);
  expect(!compile("").ok);

  // Every complaint is a sentence somebody could act on.
  expect(compile("every day at 8").error.indexOf("HH:MM") >= 0);
});

test("a compiled schedule fires where the person lives", () => {
  let paris = nextFire(every("0 0 8 * * 1-5", "Europe/Paris"), SAT);
  expect(paris.ok);
  expect(civil("Europe/Paris", stampMs(paris.at) as i64) == "2026-03-30 08:00:00 CEST");

  // Same expression, another zone, a different instant — if these matched, the
  // timezone on the row would be decoration.
  let tokyo = nextFire(every("0 0 8 * * 1-5", "Asia/Tokyo"), SAT);
  expect(civil("Asia/Tokyo", stampMs(tokyo.at) as i64) == "2026-03-30 08:00:00 JST");
  expect(paris.at != tokyo.at);
});

test("an empty timezone means UTC rather than whatever the server was set to", () => {
  let fire = nextFire(every("0 0 8 * * 1-5", ""), SAT);
  expect(civil("UTC", stampMs(fire.at) as i64) == "2026-03-30 08:00:00 UTC");
});

test("a one-off fires once and then has nothing left to do", () => {
  let row = task("once", "", "UTC", `${SAT + 3600000}`, "a1", "remind me");

  let ahead = nextFire(row, SAT);
  expect(ahead.ok);
  expect(ahead.at == row.nextAt);

  // An hour later it is behind us, and a task with no next firing is a
  // finished task — which is how the runner knows to close it rather than
  // firing it again on the next tick.
  let behind = nextFire(row, SAT + 7200000);
  expect(!behind.ok);
});

test("a date and a time is a single instant, in the person's own zone", () => {
  let paris = onceInstant("on 2026-03-30 at 08:00", "Europe/Paris", SAT);
  expect(paris.ok);
  expect(civil("Europe/Paris", stampMs(paris.at) as i64) == "2026-03-30 08:00:00 CEST");

  // The same words, another zone, another instant — an hour of difference that
  // a client computing this itself would get wrong twice a year.
  let tokyo = onceInstant("on 2026-03-30 at 08:00", "Asia/Tokyo", SAT);
  expect(paris.at != tokyo.at);

  // A year already gone. A cron expression carries no year, so without the
  // check this reads as "the 30th of March coming up" and schedules a task the
  // person did not ask for; the refusal names what it found instead.
  let behind = onceInstant("on 2019-03-30 at 08:00", "UTC", SAT);
  expect(!behind.ok);
  expect(behind.error.indexOf("in the past") >= 0);

  // A day that does not exist, refused by the library that knows the calendar
  // rather than by arithmetic here.
  expect(!onceInstant("on 2026-02-30 at 08:00", "UTC", SAT).ok);

  // Shapes that are not this grammar at all.
  expect(!onceInstant("on tomorrow at 08:00", "UTC", SAT).ok);
  expect(!onceInstant("on 2026-03-30 at 8", "UTC", SAT).ok);
  expect(!onceInstant("every day at 08:00", "UTC", SAT).ok);

  // And which of the two grammars a phrase belongs to is decided once, here,
  // rather than by each caller looking at the first word.
  expect(isOnce("on 2026-03-30 at 08:00"));
  expect(isOnce("  ON 2026-03-30 at 08:00 "));
  expect(!isOnce("every monday at 09:15"));
});

test("a task nobody could run is refused where it can still be fixed", () => {
  let ok = every("0 0 8 * * 1-5", "Europe/Paris");
  expect(refuse(ok) == "");

  let noInstruction = task("every", "0 0 8 * * 1-5", "UTC", "", "a1", "");
  expect(refuse(noInstruction) != "");

  let noAgent = task("every", "0 0 8 * * 1-5", "UTC", "", "", "do the thing");
  expect(refuse(noAgent) != "");

  // A zone this server does not have. glibc answers an unknown zone with UTC
  // instead of an error, so without this check the task would run at the right
  // time in the wrong place and look correct from every angle.
  let nowhere = every("0 0 8 * * 1-5", "Mars/Olympus");
  expect(refuse(nowhere).indexOf("Mars/Olympus") >= 0);

  // Five-field cron, the everyday dialect: read as six fields it means every
  // eighth second, so it is refused rather than accepted and misread.
  let fiveFields = every("0 8 * * 1-5", "UTC");
  expect(refuse(fiveFields) != "");

  let noSchedule = every("", "UTC");
  expect(refuse(noSchedule) != "");

  let neither = task("sometimes", "0 0 8 * * *", "UTC", "", "a1", "do the thing");
  expect(refuse(neither) != "");
});

test("the clocks going forward eat one run, deliberately", () => {
  // 02:30 does not exist in Paris on 2026-03-29. This answers the 30th rather
  // than firing at 03:30 on the 29th: a daily 02:30 task loses one run a year.
  // Asserted so that changing it is a deliberate act with a red test in front
  // of it, rather than something a library upgrade does quietly.
  let fire = nextFire(every("0 30 2 * * *", "Europe/Paris"), SAT);
  expect(civil("Europe/Paris", stampMs(fire.at) as i64) == "2026-03-30 02:30:00 CEST");
});
