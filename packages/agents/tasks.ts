// Scheduled tasks: a person describes something they want done later or
// repeatedly, and it happens without them.
//
// A task is an owner, an agent, an instruction, a schedule and a switch. When
// one fires the result is an ordinary conversation — which is the whole
// delivery mechanism, and the reason this module is small. There is no results
// store, no second rendering path and no new message type. A task that fired
// is a conversation somebody did not have to type.
//
// Nothing here keeps time or runs anything: this module answers *when* and
// *which*, and `scheduler.ts` — a separate process on a systemd timer — does
// the firing. That split is not taste. A worker function may not throw
// (`Worker.run` takes `() => T`), so the only way to run one inside the engine
// is a `try` around the whole loop, which means the first provider timeout
// ends every task on the deployment until someone restarts it. See indexer.ts,
// which is a process for the same reason.
//
// The schedule maths is `packages/cron` — ccronexpr plus the system zone
// database — so "every weekday at 08:00 in Europe/Paris" is a real answer that
// moves with daylight saving rather than an offset that is wrong for half the
// year.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, createTableSql, field, listOrdered, listWhere, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { next as nextFiring, problem as cronProblem, civil, knownZone } from "../cron/cron.ts";

// A task, as stored.
//
// Every stamp is text holding epoch milliseconds, which is what the rest of
// this package does (`${Date.now()}`) and not an oversight: `int` is 32 bits
// here and a millisecond epoch does not fit. Ordering and `<=` still behave,
// because every value is thirteen digits wide until the year 2286 and
// lexicographic order over equal-width digits is numeric order.
export type TaskRow = {
  id: string,
  // Who it belongs to. Every route filters on this; a scheduler that ignored
  // it would run one tenant's instruction and file the answer in another's
  // sidebar.
  owner: string,
  // What runs it, resolved when the task is created rather than at fire time.
  // Storing "the default" would mean changing the default silently rewrote
  // every task anyone had ever made.
  agentId: string,
  modelChoiceId: string,
  // What a person sees in the list, and what the model is actually asked.
  title: string,
  instruction: string,
  // "once" — fires at `nextAt` and is done. "every" — fires on `cronExpr`.
  kind: string,
  // Six fields, seconds first, empty for a "once" task. This is compiled from
  // the words a person typed (see `compile`) and is never shown to them:
  // nobody writes cron correctly on the first try, and a wrong expression is a
  // silently wrong answer rather than an error.
  cronExpr: string,
  // An IANA name — "Europe/Paris". Not an offset: an offset is wrong for half
  // the year in every zone that observes daylight saving.
  tz: string,
  // When it fires next. The only column the runner queries on.
  nextAt: string,
  // "" when idle, otherwise when a runner claimed it. A claim older than
  // RUN_TIMEOUT_MS belonged to a process that died and is taken back.
  runningSince: string,
  enabled: bool,
  // Consecutive failures. At PAUSE_AFTER the task switches itself off with a
  // reason, because a task that fails every hour forever is a bill.
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

/** A stamp as a number, or 0.
 *
 *  `parseFloat` and not `parseInt`, which is the trap this function exists to
 *  stop anyone falling into twice: `parseInt` answers an **i32**, and an epoch
 *  in milliseconds needs 41 bits. It does not overflow loudly — it fails to
 *  parse, answers null, and `?? 0` turns every stamp in the system into 1970.
 *  A double carries an integer exactly to 2^53, which is epoch milliseconds
 *  until the year 287396. */
export function stampMs(said: string): number {
  if (said == "") { return 0.0; }
  return parseFloat(said) ?? 0.0;
}

export function tasksMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("agentId", "agent_id", "text"),
    field("modelChoiceId", "model_choice_id", "text"),
    field("title", "title", "text"),
    field("instruction", "instruction", "text"),
    field("kind", "kind", "text"),
    field("cronExpr", "cron_expr", "text"),
    field("tz", "tz", "text"),
    field("nextAt", "next_at", "text"),
    field("runningSince", "running_since", "text"),
    field("enabled", "enabled", "bool"),
    field("failures", "failures", "int"),
    field("pausedReason", "paused_reason", "text"),
    field("lastRunAt", "last_run_at", "text"),
    field("lastRunId", "last_run_id", "text"),
    field("lastStatus", "last_status", "text"),
    field("lastError", "last_error", "text"),
    field("runCount", "run_count", "int"),
    field("createdAt", "created_at", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository("scheduled_tasks", "id", "id", fs);
}

export function tasksPlan(db: Db): Migration[] {
  return [
    // 99, not 98: discover.ts owns 98.1 through 98.5, and a migration that
    // sorts below one already applied is refused outright — which took the
    // engine down for as long as it took to notice. Check
    // `SELECT version FROM plume_schema_history ORDER BY installed_rank DESC`
    // before choosing a number, not after.
    migration("99", "tasks that run on a schedule",
      createTableSql(db, tasksMapping())),
  ];
}

// What a task costs if it goes wrong, expressed as limits rather than as hope.
// A scheduler is a loop with a provider's credit card attached, so each of
// these is enforced server-side and none of them is advisory.
export const MAX_PER_OWNER: int = 10;
export const MIN_EVERY_MINUTES: int = 15;
export const PAUSE_AFTER: int = 5;
// How long a claim may stand before the runner holding it is presumed dead.
// Longer than any sane agent turn, shorter than a person's patience.
export const RUN_TIMEOUT_MS: int = 1800000;

// ---------------------------------------------------------------------------
// The grammar
//
// People say "every weekday at 8". Cron says "0 0 8 * * 1-5". This translates
// the first into the second and nothing translates back, because cron is an
// implementation detail that never reaches a person.
//
// The grammar is deliberately small — small enough to test exhaustively, large
// enough for what people actually ask for. Widening it is a change here; it is
// not a reason to accept raw cron from a form.
// ---------------------------------------------------------------------------

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

// "mon" -> 1 ... "sun" -> 0, matching ccronexpr's day-of-week numbering.
// -1 for anything else.
function dayNumber(said: string): int {
  if (said == "sunday" || said == "sun") { return 0; }
  if (said == "monday" || said == "mon") { return 1; }
  if (said == "tuesday" || said == "tue") { return 2; }
  if (said == "wednesday" || said == "wed") { return 3; }
  if (said == "thursday" || said == "thu") { return 4; }
  if (said == "friday" || said == "fri") { return 5; }
  if (said == "saturday" || said == "sat") { return 6; }
  return -1;
}

// "08:30" -> minutes since midnight, or -1. Refuses "8:30" as well as "25:00":
// a form that accepts both spellings has two ways to be wrong and one of them
// is silent.
function clockMinutes(said: string): int {
  if (said.length != 5 || said.charAt(2) != ":") { return -1; }
  let hh = parseInt(said.slice(0, 2), 10) ?? -1;
  let mm = parseInt(said.slice(3, 5), 10) ?? -1;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) { return -1; }
  return hh * 60 + mm;
}

function digitsOnly(said: string): bool {
  if (said.length == 0) { return false; }
  let i: int = 0;
  while (i < said.length) {
    let c = said.charCodeAt(i);
    if (c < 48 || c > 57) { return false; }
    i = i + 1;
  }
  return true;
}

/** The words a person typed, as a cron expression — or why they cannot be.
 *
 *  Accepted, and this list is the whole of it:
 *
 *    every day at HH:MM
 *    every weekday at HH:MM
 *    every <monday|tue|...> at HH:MM
 *    every N hours
 *    every N minutes            (N >= MIN_EVERY_MINUTES)
 *
 *  A "once" task has no expression: it holds an instant, not a recurrence. */
export function compile(said: string): Compiled {
  let text = said.toLowerCase().trim();
  let words = text.split(" ");
  let clean: string[] = [];
  let w: int = 0;
  while (w < words.length) {
    if (words[w] != "") { clean.push(words[w]); }
    w = w + 1;
  }
  if (clean.length < 3 || clean[0] != "every") {
    return bad("a schedule starts with \"every\" — \"every weekday at 08:00\", \"every 30 minutes\"");
  }

  // every N minutes | every N hours
  if (digitsOnly(clean[1])) {
    if (clean.length != 3) { return bad("say \"every " + clean[1] + " minutes\" or \"every " + clean[1] + " hours\""); }
    let n = parseInt(clean[1], 10) ?? 0;
    let unit = clean[2];
    if (unit == "minutes" || unit == "minute") {
      if (n < MIN_EVERY_MINUTES) {
        return bad("the shortest interval is " + `${MIN_EVERY_MINUTES}` + " minutes");
      }
      if (n > 59) { return bad("for an hour or more, say it in hours"); }
      return good("0 */" + `${n}` + " * * * *");
    }
    if (unit == "hours" || unit == "hour") {
      if (n < 1 || n > 23) { return bad("hours must be between 1 and 23"); }
      return good("0 0 */" + `${n}` + " * * *");
    }
    return bad("\"" + unit + "\" is not minutes or hours");
  }

  // every <day|weekday|weekend|monday...> at HH:MM
  if (clean.length != 4 || clean[2] != "at") {
    return bad("say \"every " + clean[1] + " at 08:00\"");
  }
  let when = clockMinutes(clean[3]);
  if (when < 0) { return bad("\"" + clean[3] + "\" is not a time — write it as HH:MM, e.g. 08:00"); }
  let hh = `${when / 60}`;
  let mm = `${when % 60}`;

  let dow = clean[1];
  if (dow == "day") { return good("0 " + mm + " " + hh + " * * *"); }
  if (dow == "weekday") { return good("0 " + mm + " " + hh + " * * 1-5"); }
  if (dow == "weekend") { return good("0 " + mm + " " + hh + " * * 0,6"); }
  let n = dayNumber(dow);
  if (n >= 0) { return good("0 " + mm + " " + hh + " * * " + `${n}`); }
  return bad("\"" + dow + "\" is not a day, \"weekday\", \"weekend\" or \"day\"");
}

/** Whether these words describe a single instant rather than a recurrence. */
export function isOnce(said: string): bool {
  return said.toLowerCase().trim().startsWith("on ");
}

// ---------------------------------------------------------------------------
// When it fires
// ---------------------------------------------------------------------------

export type Scheduled = {
  ok: bool,
  at: string,
  error: string,
};

function noFire(why: string): Scheduled {
  let s: Scheduled = { ok: false, at: "", error: why };
  return s;
}

/** The next firing after `afterMs`, as a stamp, or why there is none.
 *
 *  A "once" task answers its own instant while it is still ahead, and answers
 *  nothing once it is behind — a task with no next firing is a finished task,
 *  which is how `scheduler.ts` knows to close it. */
export function nextFire(row: TaskRow, afterMs: number): Scheduled {
  if (row.kind == "once") {
    let at = stampMs(row.nextAt);
    if (at <= 0.0) { return noFire("this task has no instant to run at"); }
    if (at <= afterMs) { return noFire("already run"); }
    let once: Scheduled = { ok: true, at: row.nextAt, error: "" };
    return once;
  }
  if (row.cronExpr == "") { return noFire("this task has no schedule"); }
  let zone = row.tz == "" ? "UTC" : row.tz;
  let fire = nextFiring(zone, row.cronExpr, afterMs as i64);
  if (!fire.ok) { return noFire(fire.error); }
  let out: Scheduled = { ok: true, at: `${fire.at}`, error: "" };
  return out;
}

/** "on 2026-08-06 at 09:00" as an instant in `zone`, or why it is not one.
 *
 *  The other half of the grammar. `compile` answers recurrences and a one-off
 *  is not one — "tomorrow at nine" is a single firing and then the task is
 *  finished — so this is where a date lands. It exists because a person
 *  describing work to be done later means a date about as often as they mean a
 *  weekday, and the alternative was every caller computing epoch milliseconds
 *  and sending them, which is how a task ends up scheduled in 1970.
 *
 *  The date is resolved through the same cron machinery as everything else
 *  rather than by arithmetic here: a day-of-month plus a month is an
 *  expression, and its first firing in the zone is the instant — daylight
 *  saving, leap years and "there is no 31st of April" all decided by the
 *  library that already knows them.
 *
 *  A year in the past is the trap that makes the check at the end necessary: a
 *  cron expression carries no year, so "2019-08-06" would answer this coming
 *  August. The answer is compared back against what was asked and refused when
 *  they differ. */
export function onceInstant(said: string, zone: string, nowMs: number): Scheduled {
  let text = said.toLowerCase().trim();
  let words = text.split(" ");
  let clean: string[] = [];
  let w: int = 0;
  while (w < words.length) {
    if (words[w] != "") { clean.push(words[w]); }
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
  if (when < 0) { return noFire("\"" + clean[3] + "\" is not a time — write it as HH:MM, e.g. 09:00"); }

  let expr = "0 " + `${when % 60}` + " " + `${when / 60}` + " " + `${day}` + " " + `${month}` + " *";
  let fire = nextFiring(zone == "" ? "UTC" : zone, expr, nowMs as i64);
  if (!fire.ok) { return noFire("there is no " + date + " at " + clean[3] + " to run at"); }
  // The year, checked by reading the answer back rather than by trusting the
  // expression that produced it.
  let reads = civil(zone == "" ? "UTC" : zone, fire.at);
  if (!reads.startsWith(date)) {
    return noFire(date + " is in the past — the soonest " + `${day}` + "/" + `${month}`
      + " ahead is " + reads.slice(0, 10));
  }
  let at: Scheduled = { ok: true, at: `${fire.at}`, error: "" };
  return at;
}

/** Everything wrong with a task somebody just described, or "".
 *
 *  Called where a person can still fix it — on create and on edit — rather
 *  than in the runner. A schedule that fails to parse at fire time is a task
 *  that silently never runs, and silence is the one failure a scheduler must
 *  not have. */
export function refuse(row: TaskRow): string {
  if (row.instruction == "") { return "a task with no instruction has nothing to do"; }
  if (row.agentId == "") { return "a task needs an agent to run it"; }
  if (row.tz != "" && !knownZone(row.tz)) {
    return "\"" + row.tz + "\" is not a timezone this server knows";
  }
  if (row.kind == "once") {
    if (stampMs(row.nextAt) <= 0.0) { return "a one-off task needs the instant it should run at"; }
    return "";
  }
  if (row.kind != "every") { return "a task is \"once\" or \"every\", not \"" + row.kind + "\""; }
  if (row.cronExpr == "") { return "a repeating task needs a schedule"; }
  let complaint = cronProblem(row.cronExpr);
  if (complaint != "") { return complaint; }
  return "";
}

/** How many enabled tasks this owner already has — the limit is enforced on
 *  the way in, because the cheapest place to stop a runaway is before it is a
 *  row. */
export function enabledCount(db: Db, owner: string): int {
  let rows = JSON.parse<TaskRow[]>(listWhere(db, tasksMapping(),
    "owner = " + db.placeholder, [owner]));
  let n: int = 0;
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].enabled) { n = n + 1; }
    i = i + 1;
  }
  return n;
}

/** This owner's tasks, soonest first. */
export function tasksOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [asc("next_at")];
  return listOrdered(db, tasksMapping(), "owner = " + db.placeholder, [owner], keys);
}

// ---------------------------------------------------------------------------
// Claiming
//
// The runner claims a row before it runs it, and the claim advances `next_at`
// in the same statement. Both halves matter and neither is ceremony:
//
//   `FOR UPDATE SKIP LOCKED` is what stops two runners firing one task twice.
//   There is one runner today; the day there are two, this is the difference
//   between a config change and every subscriber getting two copies of their
//   morning briefing. It is the same primitive `indexing.ts` uses.
//
//   advancing `next_at` inside the claim is what stops a run that crashes from
//   re-firing on the next tick, forever.
// ---------------------------------------------------------------------------

/** One due task, claimed, or an empty row.
 *
 *  `nextAt` on the returned row is the time it was claimed FOR, not the next
 *  one — the caller needs the former to record what it ran, and the row in the
 *  database already holds the latter. */
export function claimDue(db: Db, nowMs: number): TaskRow {
  let none = emptyTask();
  let now = `${nowMs}`;
  let stale = `${(nowMs as i64) - (RUN_TIMEOUT_MS as i64)}`;

  // The claim, in one statement: pick the soonest task that is due, enabled,
  // and either idle or abandoned by a dead runner.
  let sql = "UPDATE scheduled_tasks SET running_since = " + db.placeholder
    + " WHERE id = (SELECT id FROM scheduled_tasks"
    + " WHERE enabled = true AND next_at <> '' AND next_at <= " + placeholderAt(db, 2)
    + " AND (running_since = '' OR running_since < " + placeholderAt(db, 3) + ")"
    + " ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED)"
    + " RETURNING id, owner, agent_id, model_choice_id, title, instruction,"
    + " kind, cron_expr, tz, next_at, failures, run_count";
  if (!db.query(sql, [now, now, stale])) { return none; }
  if (db.rows() == 0) { return none; }

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

/** A run that worked: the claim is released, the schedule moves on, and a
 *  one-off switches itself off rather than lingering as a task that can never
 *  run again. */
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

/** A run that did not work. The failure is counted and, at PAUSE_AFTER, the
 *  task switches itself off with the reason on it — visible, undoable, and not
 *  spending a provider call an hour on something that has failed five times in
 *  a row. */
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

/** The same task with a different next firing.
 *
 *  Records are immutable, so "set one field" is "build the row again". It is
 *  written once here rather than at each call site, where the long literal is
 *  exactly the kind of thing that loses a field in a copy-paste and drops an
 *  owner or a failure count on the floor. */
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

/** A row with every field empty — what a claim that found nothing returns, and
 *  what a create starts from. `id == ""` is the test for "nothing". */
export function emptyTask(): TaskRow {
  let none: TaskRow = {
    id: "", owner: "", agentId: "", modelChoiceId: "", title: "", instruction: "",
    kind: "", cronExpr: "", tz: "", nextAt: "", runningSince: "", enabled: false,
    failures: 0, pausedReason: "", lastRunAt: "", lastRunId: "", lastStatus: "",
    lastError: "", runCount: 0, createdAt: "", updatedAt: "",
  };
  return none;
}
