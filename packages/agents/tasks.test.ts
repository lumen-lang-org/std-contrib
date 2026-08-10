import { compile, isOnce, nextFire, onceInstant, refuse, stampMs, TaskRow, MIN_EVERY_MINUTES } from "./tasks.ts";
import { civil } from "../cron/cron.ts";

const SAT: number = 1774699200000;

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

  expect(compile("  EVERY   Weekday   at   08:00  ").expr == "0 0 8 * * 1-5");
});

test("what is refused, and with a sentence rather than a code", () => {
  expect(!compile("every 5 minutes").ok);
  expect(compile("every 5 minutes").error.indexOf(`${MIN_EVERY_MINUTES}`) >= 0);
  expect(!compile("at 8").ok);
  expect(!compile("every fortnight at 08:00").ok);
  expect(!compile("every day at 8").ok);
  expect(!compile("every day at 25:00").ok);
  expect(!compile("every 0 hours").ok);
  expect(!compile("").ok);

  expect(compile("every day at 8").error.indexOf("HH:MM") >= 0);
});

test("a compiled schedule fires where the person lives", () => {
  let paris = nextFire(every("0 0 8 * * 1-5", "Europe/Paris"), SAT);
  expect(paris.ok);
  expect(civil("Europe/Paris", stampMs(paris.at) as i64) == "2026-03-30 08:00:00 CEST");

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

  let behind = nextFire(row, SAT + 7200000);
  expect(!behind.ok);
});

test("a date and a time is a single instant, in the person's own zone", () => {
  let paris = onceInstant("on 2026-03-30 at 08:00", "Europe/Paris", SAT);
  expect(paris.ok);
  expect(civil("Europe/Paris", stampMs(paris.at) as i64) == "2026-03-30 08:00:00 CEST");

  let tokyo = onceInstant("on 2026-03-30 at 08:00", "Asia/Tokyo", SAT);
  expect(paris.at != tokyo.at);

  let behind = onceInstant("on 2019-03-30 at 08:00", "UTC", SAT);
  expect(!behind.ok);
  expect(behind.error.indexOf("in the past") >= 0);

  expect(!onceInstant("on 2026-02-30 at 08:00", "UTC", SAT).ok);

  expect(!onceInstant("on tomorrow at 08:00", "UTC", SAT).ok);
  expect(!onceInstant("on 2026-03-30 at 8", "UTC", SAT).ok);
  expect(!onceInstant("every day at 08:00", "UTC", SAT).ok);

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

  let nowhere = every("0 0 8 * * 1-5", "Mars/Olympus");
  expect(refuse(nowhere).indexOf("Mars/Olympus") >= 0);

  let fiveFields = every("0 8 * * 1-5", "UTC");
  expect(refuse(fiveFields) != "");

  let noSchedule = every("", "UTC");
  expect(refuse(noSchedule) != "");

  let neither = task("sometimes", "0 0 8 * * *", "UTC", "", "a1", "do the thing");
  expect(refuse(neither) != "");
});

test("the clocks going forward eat one run, deliberately", () => {
  let fire = nextFire(every("0 30 2 * * *", "Europe/Paris"), SAT);
  expect(civil("Europe/Paris", stampMs(fire.at) as i64) == "2026-03-30 02:30:00 CEST");
});
