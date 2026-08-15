import { Db } from "../plume/driver.ts";
import { DbOrder, DbRepository, countWhere, createTableSql, listOrdered, listWhere, placeholderAt } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { next as nextFiring, fault as cronFault, civil, knownZone } from "../cron/cron.ts";
import { scheduledTaskRepository } from "./routes/automation/tasks/entities/scheduled-task.entity.ts";

export type TaskRow = {
  id: string,
  owner: string,
  agentId: string,
  modelChoiceId: string,
  title: string,
  instruction: string,
  kind: string,
  cronExpr: string,
  tz: string,
  nextAt: string,
  runningSince: string,
  enabled: bool,
  failures: int,
  pausedReason: string,
  lastRunAt: string,
  lastRunId: string,
  lastStatus: string,
  lastError: string,
  runCount: int,
  createdAt: string,
  updatedAt: string,
};

export function stampMs(said: string): number {
  if (said == "") {
    return 0.0;
  }
  return parseFloat(said) ?? 0.0;
}

export function tasksMapping(): DbRepository {
  return scheduledTaskRepository();
}

export function tasksPlan(db: Db): Migration[] {
  return [
    migration("99", "tasks that run on a schedule",
      createTableSql(db, tasksMapping())),
  ];
}

export const MAX_PER_OWNER: int = 10;
export const MIN_EVERY_MINUTES: int = 15;
export const PAUSE_AFTER: int = 5;
export const RUN_TIMEOUT_MS: int = 1800000;

export type Compiled = {
  ok: bool,
  expr: string,
  error: string,
};

function bad(why: string): Compiled {
  let c: Compiled = { ok: false, expr: "", error: why };
  return c;
}

function good(expr: string): Compiled {
  let c: Compiled = { ok: true, expr: expr, error: "" };
  return c;
}

function dayNumber(said: string): int {
  if (said == "sunday" || said == "sun") {
    return 0;
  }
  if (said == "monday" || said == "mon") {
    return 1;
  }
  if (said == "tuesday" || said == "tue") {
    return 2;
  }
  if (said == "wednesday" || said == "wed") {
    return 3;
  }
  if (said == "thursday" || said == "thu") {
    return 4;
  }
  if (said == "friday" || said == "fri") {
    return 5;
  }
  if (said == "saturday" || said == "sat") {
    return 6;
  }
  return -1;
}

function clockMinutes(said: string): int {
  if (said.length != 5 || said.charAt(2) != ":") {
    return -1;
  }
  let hh = parseInt(said.slice(0, 2), 10) ?? -1;
  let mm = parseInt(said.slice(3, 5), 10) ?? -1;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return -1;
  }
  return hh * 60 + mm;
}

function digitsOnly(said: string): bool {
  if (said.length == 0) {
    return false;
  }
  let i: int = 0;
  while (i < said.length) {
    let c = said.charCodeAt(i);
    if (c < 48 || c > 57) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

export function compile(said: string): Compiled {
  let text = said.toLowerCase().trim();
  let words = text.split(" ");
  let clean: string[] = [];
  let w: int = 0;
  while (w < words.length) {
    if (words[w] != "") {
      clean.push(words[w]);
    }
    w = w + 1;
  }
  if (clean.length < 3 || clean[0] != "every") {
    return bad("a schedule starts with \"every\" — \"every weekday at 08:00\", \"every 30 minutes\"");
  }

  if (digitsOnly(clean[1])) {
    if (clean.length != 3) {
      return bad("say \"every " + clean[1] + " minutes\" or \"every " + clean[1] + " hours\"");
    }
    let n = parseInt(clean[1], 10) ?? 0;
    let unit = clean[2];
    if (unit == "minutes" || unit == "minute") {
      if (n < MIN_EVERY_MINUTES) {
        return bad("the shortest interval is " + `${MIN_EVERY_MINUTES}` + " minutes");
      }
      if (n > 59) {
        return bad("for an hour or more, say it in hours");
      }
      return good("0 */" + `${n}` + " * * * *");
    }
    if (unit == "hours" || unit == "hour") {
      if (n < 1 || n > 23) {
        return bad("hours must be between 1 and 23");
      }
      return good("0 0 */" + `${n}` + " * * *");
    }
    return bad("\"" + unit + "\" is not minutes or hours");
  }

  if (clean.length != 4 || clean[2] != "at") {
    return bad("say \"every " + clean[1] + " at 08:00\"");
  }
  let when = clockMinutes(clean[3]);
  if (when < 0) {
    return bad("\"" + clean[3] + "\" is not a time — write it as HH:MM, e.g. 08:00");
  }
  let hh = `${when / 60}`;
  let mm = `${when % 60}`;

  let dow = clean[1];
  if (dow == "day") {
    return good("0 " + mm + " " + hh + " * * *");
  }
  if (dow == "weekday") {
    return good("0 " + mm + " " + hh + " * * 1-5");
  }
  if (dow == "weekend") {
    return good("0 " + mm + " " + hh + " * * 0,6");
  }
  let n = dayNumber(dow);
  if (n >= 0) {
    return good("0 " + mm + " " + hh + " * * " + `${n}`);
  }
  return bad("\"" + dow + "\" is not a day, \"weekday\", \"weekend\" or \"day\"");
}

export function isOnce(said: string): bool {
  return said.toLowerCase().trim().startsWith("on ");
}

export type Scheduled = {
  ok: bool,
  at: string,
  error: string,
};

function noFire(why: string): Scheduled {
  let s: Scheduled = { ok: false, at: "", error: why };
  return s;
}

export function nextFire(row: TaskRow, afterMs: number): Scheduled {
  if (row.kind == "once") {
    let at = stampMs(row.nextAt);
    if (at <= 0.0) {
      return noFire("this task has no instant to run at");
    }
    if (at <= afterMs) {
      return noFire("already run");
    }
    let once: Scheduled = { ok: true, at: row.nextAt, error: "" };
    return once;
  }
  if (row.cronExpr == "") {
    return noFire("this task has no schedule");
  }
  let zone = row.tz == "" ? "UTC" : row.tz;
  let fire = nextFiring(zone, row.cronExpr, afterMs as i64);
  if (!fire.ok) {
    return noFire(fire.error);
  }
  let out: Scheduled = { ok: true, at: `${fire.at}`, error: "" };
  return out;
}

export function onceInstant(said: string, zone: string, nowMs: number): Scheduled {
  let text = said.toLowerCase().trim();
  let words = text.split(" ");
  let clean: string[] = [];
  let w: int = 0;
  while (w < words.length) {
    if (words[w] != "") {
      clean.push(words[w]);
    }
    w = w + 1;
  }
  if (clean.length != 4 || clean[0] != "on" || clean[2] != "at") {
    return noFire("say \"on 2026-08-06 at 09:00\" — a date, then a time");
  }
  let date = clean[1];
  if (date.length != 10 || date.charAt(4) != "-" || date.charAt(7) != "-") {
    return noFire("\"" + date + "\" is not a date — write it as YYYY-MM-DD");
  }
  let year = parseInt(date.slice(0, 4), 10) ?? 0;
  let month = parseInt(date.slice(5, 7), 10) ?? 0;
  let day = parseInt(date.slice(8, 10), 10) ?? 0;
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) {
    return noFire("\"" + date + "\" is not a date this understands");
  }
  let when = clockMinutes(clean[3]);
  if (when < 0) {
    return noFire("\"" + clean[3] + "\" is not a time — write it as HH:MM, e.g. 09:00");
  }

  let expr = "0 " + `${when % 60}` + " " + `${when / 60}` + " " + `${day}` + " " + `${month}` + " *";
  let fire = nextFiring(zone == "" ? "UTC" : zone, expr, nowMs as i64);
  if (!fire.ok) {
    return noFire("there is no " + date + " at " + clean[3] + " to run at");
  }
  let reads = civil(zone == "" ? "UTC" : zone, fire.at);
  if (!reads.startsWith(date)) {
    return noFire(date + " is in the past — the soonest " + `${day}` + "/" + `${month}`
      + " ahead is " + reads.slice(0, 10));
  }
  let at: Scheduled = { ok: true, at: `${fire.at}`, error: "" };
  return at;
}

export function refuse(row: TaskRow): string {
  if (row.instruction == "") {
    return "a task with no instruction has nothing to do";
  }
  if (row.agentId == "") {
    return "a task needs an agent to run it";
  }
  if (row.tz != "" && !knownZone(row.tz)) {
    return "\"" + row.tz + "\" is not a timezone this server knows";
  }
  if (row.kind == "once") {
    if (stampMs(row.nextAt) <= 0.0) {
      return "a one-off task needs the instant it should run at";
    }
    return "";
  }
  if (row.kind != "every") {
    return "a task is \"once\" or \"every\", not \"" + row.kind + "\"";
  }
  if (row.cronExpr == "") {
    return "a repeating task needs a schedule";
  }
  let complaint = cronFault(row.cronExpr);
  if (complaint != "") {
    return complaint;
  }
  return "";
}

/** How many tasks this owner has running, or -1 when that cannot be counted.
 *
 *  Counted rather than listed and filtered: listWhere answers "[]" both for an
 *  owner with no tasks and for a query that did not run, and this number is
 *  what MAX_PER_OWNER is measured against — a cap that reads zero when the
 *  count fails is no cap. */
export function enabledCount(db: Db, owner: string): int {
  return countWhere(db, tasksMapping(),
    "owner = " + db.placeholder + " AND enabled = true", [owner]);
}

export function tasksOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [{ column: "next_at" }];
  return listOrdered(db, tasksMapping(), {
    where: "owner = " + db.placeholder,
    args: [owner],
    order: keys,
  });
}

export function claimDue(db: Db, nowMs: number): TaskRow {
  let none = emptyTask();
  let now = `${nowMs}`;
  let stale = `${(nowMs as i64) - (RUN_TIMEOUT_MS as i64)}`;

  let sql = "UPDATE scheduled_tasks SET running_since = " + db.placeholder
    + " WHERE id = (SELECT id FROM scheduled_tasks"
    + " WHERE enabled = true AND next_at <> '' AND next_at <= " + placeholderAt(db, 2)
    + " AND (running_since = '' OR running_since < " + placeholderAt(db, 3) + ")"
    + " ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED)"
    + " RETURNING id, owner, agent_id, model_choice_id, title, instruction,"
    + " kind, cron_expr, tz, next_at, failures, run_count";
  if (!db.query(sql, [now, now, stale])) {
    return none;
  }
  if (db.rows() == 0) {
    return none;
  }

  let got: TaskRow = {
    id: db.value(0, 0),
    owner: db.value(0, 1),
    agentId: db.value(0, 2),
    modelChoiceId: db.value(0, 3),
    title: db.value(0, 4),
    instruction: db.value(0, 5),
    kind: db.value(0, 6),
    cronExpr: db.value(0, 7),
    tz: db.value(0, 8),
    nextAt: db.value(0, 9),
    runningSince: now,
    enabled: true,
    failures: parseInt(db.value(0, 10), 10) ?? 0,
    pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: parseInt(db.value(0, 11), 10) ?? 0,
    createdAt: "", updatedAt: "",
  };
  return got;
}

export function markRan(db: Db, row: TaskRow, runId: string, nowMs: number): void {
  let ahead = nextFire(row, nowMs);
  let stillOn = row.kind == "every" && ahead.ok;
  let sql = "UPDATE scheduled_tasks SET running_since = '', failures = 0, paused_reason = '',"
    + " last_run_at = " + db.placeholder
    + ", last_run_id = " + placeholderAt(db, 2)
    + ", last_status = 'ok', last_error = ''"
    + ", run_count = run_count + 1"
    + ", enabled = " + placeholderAt(db, 3)
    + ", next_at = " + placeholderAt(db, 4)
    + ", updated_at = " + placeholderAt(db, 5)
    + " WHERE id = " + placeholderAt(db, 6);
  let now = `${nowMs}`;
  db.query(sql, [now, runId, stillOn ? "true" : "false", stillOn ? ahead.at : "", now, row.id]);
}

export function markFailed(db: Db, row: TaskRow, why: string, nowMs: number): void {
  let failures = row.failures + 1;
  let done = failures >= PAUSE_AFTER;
  let ahead = nextFire(row, nowMs);
  let stillOn = !done && row.kind == "every" && ahead.ok;
  let sql = "UPDATE scheduled_tasks SET running_since = '', failures = " + db.placeholder
    + ", last_run_at = " + placeholderAt(db, 2)
    + ", last_status = 'failed', last_error = " + placeholderAt(db, 3)
    + ", enabled = " + placeholderAt(db, 4)
    + ", paused_reason = " + placeholderAt(db, 5)
    + ", next_at = " + placeholderAt(db, 6)
    + ", updated_at = " + placeholderAt(db, 7)
    + " WHERE id = " + placeholderAt(db, 8);
  let now = `${nowMs}`;
  let reason = done ? "paused after " + `${failures}` + " failures: " + why : "";
  db.query(sql, [`${failures}`, now, why, stillOn ? "true" : "false", reason,
    stillOn ? ahead.at : "", now, row.id]);
}

export function withNextAt(row: TaskRow, at: string): TaskRow {
  let moved: TaskRow = {
    id: row.id, owner: row.owner, agentId: row.agentId,
    modelChoiceId: row.modelChoiceId, title: row.title,
    instruction: row.instruction, kind: row.kind, cronExpr: row.cronExpr,
    tz: row.tz, nextAt: at, runningSince: row.runningSince,
    enabled: row.enabled, failures: row.failures,
    pausedReason: row.pausedReason, lastRunAt: row.lastRunAt,
    lastRunId: row.lastRunId, lastStatus: row.lastStatus,
    lastError: row.lastError, runCount: row.runCount,
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
  return moved;
}

export function emptyTask(): TaskRow {
  let none: TaskRow = {
    id: "", owner: "", agentId: "", modelChoiceId: "", title: "", instruction: "",
    kind: "", cronExpr: "", tz: "", nextAt: "", runningSince: "", enabled: false,
    failures: 0, pausedReason: "", lastRunAt: "", lastRunId: "", lastStatus: "",
    lastError: "", runCount: 0, createdAt: "", updatedAt: "",
  };
  return none;
}
