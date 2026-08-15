import { Db } from "../plume/driver.ts";
import { deleteById, executeWith, findById, listWhere, persist, placeholderAt } from "../plume/plume.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { FileToolResult } from "./workspace.ts";
import { jsonFlag, jsonText } from "./scan.ts";
import { trustsProxyAuth } from "./owner.ts";
import { civil, knownZone } from "../cron/cron.ts";
import { MAX_PER_OWNER, MIN_EVERY_MINUTES, TaskRow, compile, emptyTask, enabledCount, isOnce, nextFire, onceInstant, refuse, stampMs, tasksMapping, withNextAt } from "./tasks.ts";

const QUOTE_LIMIT: int = 200;

export function maySchedule(owner: string): bool {
  if (owner.startsWith("guest:")) {
    return false;
  }
  if (owner == "" && trustsProxyAuth()) {
    return false;
  }
  return true;
}

export type TaskToolCall = {
  owner: string,
  agentId: string,
  modelChoiceId: string,
  name: string,
  args: string,
  nowMs: number,
};

function not(): FileToolResult {
  let none: FileToolResult = { handled: false, ok: false, text: "", line: 0, changed: "" };
  return none;
}

function no(why: string): FileToolResult {
  let bad: FileToolResult = { handled: true, ok: false, text: why, line: 0, changed: "" };
  return bad;
}

function yes(text: string): FileToolResult {
  let good: FileToolResult = { handled: true, ok: true, text: text, line: 0, changed: "" };
  return good;
}

export function taskTools(): ToolSpec[] {
  let schedule = "How often, in words. Repeating: \\\"every day at 07:30\\\", \\\"every weekday at 08:00\\\", "
    + "\\\"every monday at 09:15\\\", \\\"every 30 minutes\\\" (at least " + `${MIN_EVERY_MINUTES}` + "), \\\"every 6 hours\\\". "
    + "Once, then finished: \\\"on 2026-08-06 at 09:00\\\" - a date and a time, never \\\"tomorrow\\\" or \\\"next friday\\\", "
    + "which this does not read. Times are HH:MM on a 24-hour clock, zero-padded.";
  let zone = "The IANA timezone the person's clock is in, such as Europe/Paris. "
    + "Leave it out unless they have said where they are: the zone their other tasks use is assumed, "
    + "and the answer names whichever was used so a wrong assumption can be corrected.";

  let out: ToolSpec[] = [];
  out.push(toolSpec("list_tasks",
    "The work this person has already scheduled: what each one does, when it next runs, and how the last run went. "
    + "Call it before changing or deleting anything — the id every other task tool takes comes from here — "
    + "and before scheduling something that sounds like it already exists.",
    "{\"type\":\"object\",\"properties\":{}}"));

  out.push(toolSpec("schedule_task",
    "Set something to happen later, or repeatedly, without the person being here. "
    + "Each firing opens a conversation of its own and answers it, so the instruction is written to whoever runs it — "
    + "\"summarise what changed in my Linear cycle and name anything blocked\" — not to the person, and never \"remind me to\": "
    + "nobody reads it out, it is carried out. "
    + "The reply names the next firing in the person's own zone; say that back to them rather than repeating the schedule. "
    + "A person may have " + `${MAX_PER_OWNER}` + " running at once.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"instruction\":{\"type\":\"string\",\"description\":\"What should be done, each time it runs. Written as an instruction to whoever runs it, and self-contained: it runs in an empty conversation, so nothing from this one is carried into it.\"},"
    + "\"schedule\":{\"type\":\"string\",\"description\":\"" + schedule + "\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"A few words for the list, such as \\\"Morning Linear check\\\".\"},"
    + "\"timezone\":{\"type\":\"string\",\"description\":\"" + zone + "\"}},"
    + "\"required\":[\"instruction\",\"schedule\"]}"));

  out.push(toolSpec("change_task",
    "Change a task that already exists: its instruction, its schedule, its name, or whether it runs at all. "
    + "Only what is sent is changed; everything left out stays as it was. "
    + "Pausing is enabled=false and is the right answer to \"stop doing that\" — deleting throws away what it has already run.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"id\":{\"type\":\"string\",\"description\":\"From list_tasks. Its name works too when only one task has it.\"},"
    + "\"instruction\":{\"type\":\"string\",\"description\":\"The new instruction, whole. Leave out to keep the old one.\"},"
    + "\"schedule\":{\"type\":\"string\",\"description\":\"" + schedule + " Leave out to keep the current one.\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"A new name for the list.\"},"
    + "\"enabled\":{\"type\":\"boolean\",\"description\":\"false pauses it, true starts it again and clears its failures.\"},"
    + "\"timezone\":{\"type\":\"string\",\"description\":\"" + zone + "\"}},"
    + "\"required\":[\"id\"]}"));

  out.push(toolSpec("run_task_now",
    "Run a scheduled task at the next opportunity instead of waiting for its time — how somebody checks that what they just set up does what they meant. "
    + "It does not run inside this conversation and this call does not wait for it: the runner picks it up within about a minute and files the answer as a conversation of its own. "
    + "The task's own schedule is untouched.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"id\":{\"type\":\"string\",\"description\":\"From list_tasks. Its name works too when only one task has it.\"}},"
    + "\"required\":[\"id\"]}"));

  out.push(toolSpec("delete_task",
    "Remove a scheduled task for good. Only when the person asked for it gone — "
    + "\"stop\", \"pause\", \"not for now\" all mean change_task with enabled=false, which is undoable, and this is not.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"id\":{\"type\":\"string\",\"description\":\"From list_tasks. Its name works too when only one task has it.\"}},"
    + "\"required\":[\"id\"]}"));
  return out;
}

function rowsOf(db: Db, owner: string): TaskRow[] {
  return JSON.parse<TaskRow[]>(listWhere(db, tasksMapping(),
    "owner = " + db.placeholder, [owner]));
}

function zoneFor(db: Db, owner: string, asked: string): string {
  if (asked != "") {
    return asked;
  }
  let rows = rowsOf(db, owner);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].tz != "") {
      return rows[i].tz;
    }
    i = i + 1;
  }
  let set = (process.env("AGENTS_TZ") ?? "").trim();
  if (set != "") {
    return set;
  }
  return "UTC";
}

function mine(db: Db, owner: string, said: string): TaskRow {
  let none = emptyTask();
  if (said == "") {
    return none;
  }
  let document = findById(db, tasksMapping(), said);
  if (document != "") {
    let row: TaskRow = JSON.parse<TaskRow>(document);
    if (row.owner == owner) {
      return row;
    }
    return none;
  }
  let wanted = said.toLowerCase().trim();
  let rows = rowsOf(db, owner);
  let found = none;
  let hits: int = 0;
  let i: int = 0;
  while (i < rows.length) {
    let title = rows[i].title.toLowerCase().trim();
    if (title != "" && title == wanted) {
      found = rows[i];
      hits = hits + 1;
    }
    i = i + 1;
  }
  if (hits == 1) {
    return found;
  }
  return none;
}

function nextReads(row: TaskRow): string {
  if (!row.enabled) {
    return "paused";
  }
  let at = stampMs(row.nextAt);
  if (at <= 0.0) {
    return "nothing scheduled";
  }
  return civil(row.tz == "" ? "UTC" : row.tz, at as i64);
}

function describe(row: TaskRow, full: bool): string {
  let name = row.title == "" ? "(unnamed)" : row.title;
  let line = name + " [" + row.id + "]";
  line = line + "\n  next: " + nextReads(row);
  if (row.tz != "") {
    line = line + " (" + row.tz + ")";
  }
  if (row.kind == "once") {
    line = line + ", then finished";
  }
  if (full) {
    line = line + "\n  does: " + row.instruction;
  }
  if (row.runCount > 0) {
    line = line + "\n  ran " + `${row.runCount}` + " time" + (row.runCount == 1 ? "" : "s");
    if (row.lastStatus == "failed") {
      line = line + ", last one failed: " + row.lastError;
    }
  }
  if (!row.enabled && row.pausedReason != "") {
    line = line + "\n  paused: " + row.pausedReason;
  }
  return line;
}

type Timing = {
  ok: bool,
  kind: string,
  expr: string,
  at: string,
  error: string,
};

function timingFor(said: string, zone: string, nowMs: number): Timing {
  if (isOnce(said)) {
    let once = onceInstant(said, zone, nowMs);
    if (!once.ok) {
      let refused: Timing = { ok: false, kind: "", expr: "", at: "", error: once.error };
      return refused;
    }
    let single: Timing = { ok: true, kind: "once", expr: "", at: once.at, error: "" };
    return single;
  }
  let compiled = compile(said);
  if (!compiled.ok) {
    let refused: Timing = { ok: false, kind: "", expr: "", at: "", error: compiled.error };
    return refused;
  }
  let every: Timing = { ok: true, kind: "every", expr: compiled.expr, at: "", error: "" };
  return every;
}

export function callTaskTool(db: Db, call: TaskToolCall): FileToolResult {
  if (call.name != "list_tasks" && call.name != "schedule_task"
    && call.name != "change_task" && call.name != "run_task_now"
    && call.name != "delete_task") {
    return not();
  }
  if (!maySchedule(call.owner)) {
    return no("signing in is what makes a task yours to run — say so, and offer to set it up once they have.");
  }

  if (call.name == "list_tasks") {
    let rows = rowsOf(db, call.owner);
    if (rows.length == 0) {
      return yes("Nothing is scheduled yet.");
    }
    let out = `${rows.length}` + " scheduled:";
    let i: int = 0;
    while (i < rows.length) {
      out = out + "\n\n" + describe(rows[i], i < QUOTE_LIMIT);
      i = i + 1;
    }
    return yes(out);
  }

  if (call.name == "schedule_task") {
    let instruction = jsonText(call.args, "instruction").trim();
    if (instruction == "") {
      return no("say what should happen: {\"instruction\":\"...\",\"schedule\":\"every weekday at 08:00\"}");
    }
    let said = jsonText(call.args, "schedule").trim();
    if (said == "") {
      return no("say when: \"every weekday at 08:00\", \"every 30 minutes\", or \"on 2026-08-06 at 09:00\".");
    }

    let asked = jsonText(call.args, "timezone").trim();
    if (asked != "" && !knownZone(asked)) {
      return no("\"" + asked + "\" is not a timezone this server knows — an IANA name such as Europe/Paris.");
    }
    let zone = zoneFor(db, call.owner, asked);
    let running = enabledCount(db, call.owner);
    if (running < 0) {
      return no("how many tasks are already running could not be counted, so this one is not being added. Try again in a moment.");
    }
    if (running >= MAX_PER_OWNER) {
      return no("that is " + `${MAX_PER_OWNER}` + " tasks already — one has to be paused or deleted before another can run. list_tasks shows them.");
    }
    let timing = timingFor(said, zone, call.nowMs);
    if (!timing.ok) {
      return no(timing.error);
    }

    let now = `${call.nowMs}`;
    let row: TaskRow = {
      id: crypto.randomUUID(),
      owner: call.owner,
      agentId: call.agentId,
      modelChoiceId: call.modelChoiceId,
      title: jsonText(call.args, "title").trim(),
      instruction: instruction,
      kind: timing.kind,
      cronExpr: timing.expr,
      tz: zone,
      nextAt: timing.at,
      runningSince: "",
      enabled: true,
      failures: 0,
      pausedReason: "",
      lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
      runCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    let wrong = refuse(row);
    if (wrong != "") {
      return no(wrong);
    }
    let ready = row;
    if (timing.kind == "every") {
      let first = nextFire(row, call.nowMs);
      if (!first.ok) {
        return no(first.error);
      }
      ready = withNextAt(row, first.at);
    }
    let written = persist(db, tasksMapping(), JSON.stringify(ready));
    if (!written.ok) {
      return no(written.error);
    }
    return yes("Scheduled.\n\n" + describe(ready, true)
      + "\n\nIt opens a conversation of its own each time it runs."
      + (asked == "" ? "\nTimes are read in " + zone + " — say so, in case that is not where they are." : ""));
  }

  let row = mine(db, call.owner, jsonText(call.args, "id").trim());
  if (row.id == "") {
    return no("no task of theirs by that id or name — call list_tasks and use an id from it.");
  }

  if (call.name == "run_task_now") {
    if (!row.enabled) {
      let running = enabledCount(db, call.owner);
      if (running < 0) {
        return no("how many tasks are already running could not be counted, so this one is not being resumed. Try again in a moment.");
      }
      if (running >= MAX_PER_OWNER) {
        return no("that is " + `${MAX_PER_OWNER}` + " tasks already — one has to be paused or deleted before this one can run. list_tasks shows them.");
      }
    }
    let now = `${call.nowMs}`;
    let written = executeWith(db,
      "UPDATE scheduled_tasks SET next_at = " + db.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(db, 2)
      + " WHERE id = " + placeholderAt(db, 3),
      [now, now, row.id]);
    if (!written.ok) {
      return no(written.error);
    }
    return yes("\"" + (row.title == "" ? row.instruction : row.title)
      + "\" will run within about a minute, in a conversation of its own — it does not answer here. "
      + "Its own schedule is unchanged.");
  }

  if (call.name == "delete_task") {
    let gone = deleteById(db, tasksMapping(), row.id);
    if (!gone.ok) {
      return no(gone.error);
    }
    return yes("Deleted \"" + (row.title == "" ? row.instruction : row.title) + "\". It will not run again.");
  }

  let asked = jsonText(call.args, "timezone").trim();
  if (asked != "" && !knownZone(asked)) {
    return no("\"" + asked + "\" is not a timezone this server knows — an IANA name such as Europe/Paris.");
  }
  let zone = asked == "" ? row.tz : asked;
  let said = jsonText(call.args, "schedule").trim();
  let kind = row.kind;
  let expr = row.cronExpr;
  let at = row.nextAt;
  if (said != "") {
    let timing = timingFor(said, zone, call.nowMs);
    if (!timing.ok) {
      return no(timing.error);
    }
    kind = timing.kind;
    expr = timing.expr;
    at = timing.at;
  }
  let title = jsonText(call.args, "title").trim();
  let instruction = jsonText(call.args, "instruction").trim();
  let on = jsonFlag(call.args, "enabled", row.enabled);
  if (on && !row.enabled) {
    let running = enabledCount(db, call.owner);
    if (running < 0) {
      return no("how many tasks are already running could not be counted, so this one is not being resumed. Try again in a moment.");
    }
    if (running >= MAX_PER_OWNER) {
      return no("that is " + `${MAX_PER_OWNER}` + " tasks already — one has to be paused or deleted before another can run. list_tasks shows them.");
    }
  }

  let edited: TaskRow = {
    id: row.id, owner: row.owner, agentId: row.agentId,
    modelChoiceId: row.modelChoiceId,
    title: title == "" ? row.title : title,
    instruction: instruction == "" ? row.instruction : instruction,
    kind: kind, cronExpr: expr, tz: zone,
    nextAt: at, runningSince: row.runningSince,
    enabled: on,
    failures: on && !row.enabled ? 0 : row.failures,
    pausedReason: on ? "" : row.pausedReason,
    lastRunAt: row.lastRunAt, lastRunId: row.lastRunId,
    lastStatus: row.lastStatus, lastError: row.lastError,
    runCount: row.runCount, createdAt: row.createdAt, updatedAt: `${call.nowMs}`,
  };
  let wrong = refuse(edited);
  if (wrong != "") {
    return no(wrong);
  }
  let stored = edited;
  if (edited.kind == "every") {
    let ahead = nextFire(edited, call.nowMs);
    if (!ahead.ok) {
      return no(ahead.error);
    }
    stored = withNextAt(edited, ahead.at);
  }
  let written = persist(db, tasksMapping(), JSON.stringify(stored));
  if (!written.ok) {
    return no(written.error);
  }
  return yes("Changed.\n\n" + describe(stored, true));
}
