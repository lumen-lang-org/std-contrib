// Triggers: a workflow started by something arriving, rather than by a clock.
//
// The first kind is Telegram. A bot is polled — `getUpdates` with a long
// timeout, which is one HTTPS call that blocks until Telegram answers — and
// every message becomes a row in an inbox. Nothing here runs a workflow.
//
// THAT SEPARATION IS THE POINT. The scheduler stays the only place a workflow
// is claimed, walked and recorded (scheduler.ts says so twice, and tasks.ts
// before it). A trigger that ran its own workflows would be a second runner
// with its own idea of failure counts, conversations and limits — and the
// first bug would be a workflow that fired twice for one message.
//
//   poller ──► inbox row ──► scheduler claims ──► run ──► answer ──► sender
//
// WHAT THE REVIEW OF THE PLAN CHANGED, and why the order here is what it is:
//
//   The ceiling comes first. Every inbound message spends model tokens, and a
//   group chat is an unbounded bill. MAX_WORKFLOWS_PER_OWNER bounds how many
//   standing instructions somebody keeps; nothing bounded how often one of
//   them fires until this file.
//
//   One process per bot, not one process for all bots. A 25-second long poll
//   blocks its process; ten bots in one loop means a message can wait four
//   minutes. `Worker.run` cannot help — a worker body may not throw and
//   everything here throws — so the answer is the shape this repository
//   already uses for exactly this: a systemd template unit, joule-trigger@id,
//   the way joule-extract@1..4 works.
//
//   Delivery is at-least-once, deduped on Telegram's own update_id. Commit
//   the offset before enqueuing and a crash loses a message; enqueue first
//   and a crash repeats one. A repeat can be rejected; a loss is invisible.
//
//   cd packages/agents && lumen test triggers.test.ts

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, createTableSql, desc, field, listOrdered, listWhere, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { jsonList, jsonRaw, jsonText } from "./scan.ts";

// What one bot may cost. Deliberately small: these are the numbers somebody
// raises on purpose after watching a real chat, not the numbers that let a
// first mistake run all night.
export const TRIGGER_RUNS_PER_DAY: int = 200;
export const TRIGGER_RUNS_PER_MINUTE: int = 6;
// How long a poller's claim on a bot is good for. Renewed while it polls; a
// process that dies leaves a lease that expires rather than a bot nobody may
// ever poll again.
export const TRIGGER_LEASE_MS: int = 90000;
// A message longer than this is truncated before it becomes a workflow's
// input. The graph's own bounds apply after; this stops a pasted book from
// becoming a row first.
export const TRIGGER_INPUT_MAX: int = 8000;

export type TriggerBotRow = {
  id: string,
  owner: string,
  // "telegram" for now. The kind decides which poller understands the row,
  // and nothing else in this file branches on it.
  kind: string,
  // A label for the list. The bot's own name is Telegram's to change.
  name: string,
  // The workflow every message starts. One workflow per bot: a bot that
  // started several would need a rule for which, and there is no such rule
  // anybody would guess.
  workflowId: string,
  // Where the token is, in credentials.ts terms — never the token itself.
  credentialRef: string,
  // Telegram's cursor. Everything up to and including this has been seen.
  offset: string,
  // Who is polling it, and until when. See TRIGGER_LEASE_MS.
  leaseBy: string,
  leaseUntil: string,
  enabled: bool,
  // What it has cost today, and when that day started.
  runsToday: int,
  dayStartedAt: string,
  lastAt: string,
  lastError: string,
  createdAt: string,
  updatedAt: string,
};

// One arrival. The row exists before the run does, so a message is never lost
// between "it came in" and "something ran".
export type TriggerInboxRow = {
  id: string,
  owner: string,
  botId: string,
  workflowId: string,
  // Telegram's update_id, as text. The dedupe key: at-least-once delivery
  // means this row may be offered twice, and the second one is refused by the
  // unique-ish check in `alreadyHave`.
  updateId: string,
  // Where to answer. Kept on the row rather than looked up later: by the time
  // an answer exists the poller may have restarted.
  chatId: string,
  input: string,
  // "queued", "running", "done", "failed", "refused".
  status: string,
  runId: string,
  answer: string,
  error: string,
  createdAt: string,
  updatedAt: string,
};

export function triggerBotsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("kind", "kind", "text"),
    field("name", "name", "text"),
    field("workflowId", "workflow_id", "text"),
    field("credentialRef", "credential_ref", "text"),
    field("offset", "cursor_offset", "text"),
    field("leaseBy", "lease_by", "text"),
    field("leaseUntil", "lease_until", "text"),
    field("enabled", "enabled", "bool"),
    field("runsToday", "runs_today", "int"),
    field("dayStartedAt", "day_started_at", "text"),
    field("lastAt", "last_at", "text"),
    field("lastError", "last_error", "text"),
    field("createdAt", "created_at", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository("trigger_bots", "id", "id", fs);
}

export function triggerInboxMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("botId", "bot_id", "text"),
    field("workflowId", "workflow_id", "text"),
    field("updateId", "update_id", "text"),
    field("chatId", "chat_id", "text"),
    field("input", "input", "text"),
    field("status", "status", "text"),
    field("runId", "run_id", "text"),
    field("answer", "answer", "text"),
    field("error", "error", "text"),
    field("createdAt", "created_at", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository("trigger_inbox", "id", "id", fs);
}

export function triggersPlan(db: Db): Migration[] {
  // 106: 105 is the highest recorded. Check
  // `SELECT version FROM plume_schema_history ORDER BY installed_rank DESC`
  // before choosing a number, not after — a migration that sorts below one
  // already applied refuses the whole plan.
  return [
    migration("106", "triggers: workflows started by something arriving",
      createTableSql(db, triggerBotsMapping())),
    migration("106.1", "and what arrived",
      createTableSql(db, triggerInboxMapping())),
  ];
}

// ---------------------------------------------------------------------------
// What Telegram said
// ---------------------------------------------------------------------------

// One message, as this file cares about it. Everything else Telegram sends —
// edits, joins, reactions, the sender's language — is stepped over: a trigger
// that acted on every kind of update would fire a workflow when somebody
// changed their profile photo.
export type TriggerUpdate = {
  updateId: string,
  chatId: string,
  text: string,
};

/** The plain messages in a getUpdates body, in order.
 *
 *  Read with the flat scanner rather than a typed parse, for the reason
 *  scan.ts exists: this document's shape is Telegram's, it grows fields on
 *  their schedule, and `JSON.parse<T>` refuses a document with a field it has
 *  not been told about. */
export function updatesIn(body: string): TriggerUpdate[] {
  let out: TriggerUpdate[] = [];
  // jsonRaw, not jsonText: `ok` is a BOOLEAN and jsonText decodes string
  // values, so it answered "" for every body Telegram has ever sent and this
  // guard rejected all of them.
  if (jsonRaw(body, "ok").trim() != "true") { return out; }
  let each = jsonList(jsonRaw(body, "result"));
  let i: int = 0;
  while (i < each.length) {
    let one = each[i];
    // Numbers, not strings: update_id and chat.id come back as JSON numbers
    // and jsonText decodes STRING values, so it answers "" for both. Only
    // `text` is a string. This caught three fields in one file.
    let id = jsonRaw(one, "update_id").trim();
    let message = jsonRaw(one, "message");
    if (id != "" && message != "") {
      let chat = jsonRaw(message, "chat");
      let chatId = chat == "" ? "" : jsonRaw(chat, "id").trim();
      let text = jsonText(message, "text");
      // No text is no instruction. A photo with no caption starting a
      // workflow would run it on the empty string.
      if (chatId != "" && text.trim() != "") {
        let said: TriggerUpdate = { updateId: id, chatId: chatId,
          text: text.length > TRIGGER_INPUT_MAX ? text.slice(0, TRIGGER_INPUT_MAX) : text };
        out.push(said);
      }
    }
    i = i + 1;
  }
  return out;
}

/** The cursor to ask for next: one past the highest seen. Telegram's own
 *  contract — sending it is what acknowledges everything below it. */
export function nextOffset(seen: TriggerUpdate[], now: string): string {
  let highest: int = parseInt(now, 10) ?? 0;
  let i: int = 0;
  while (i < seen.length) {
    let id = parseInt(seen[i].updateId, 10) ?? 0;
    if (id >= highest) { highest = id + 1; }
    i = i + 1;
  }
  return `${highest}`;
}

// ---------------------------------------------------------------------------
// What a bot is allowed to cost
// ---------------------------------------------------------------------------

export type TriggerVerdict = {
  ok: bool,
  reason: string,
};

/** Whether this bot may start another run right now.
 *
 *  Two ceilings, and they answer different fears: the day cap bounds the
 *  bill, the minute cap bounds a burst — a group chat that wakes up, or
 *  somebody holding down a key. Both are refusals with a sentence, because a
 *  message that is silently dropped reads as a broken bot. */
export function mayRun(bot: TriggerBotRow, recentMinute: int, nowMs: number): TriggerVerdict {
  if (!bot.enabled) {
    let off: TriggerVerdict = { ok: false, reason: "this bot is switched off" };
    return off;
  }
  let dayStarted = parseInt(bot.dayStartedAt, 10) ?? 0;
  let fresh = (nowMs as int) - dayStarted > 86400000;
  let today = fresh ? 0 : bot.runsToday;
  if (today >= TRIGGER_RUNS_PER_DAY) {
    let spent: TriggerVerdict = { ok: false,
      reason: "that is " + `${TRIGGER_RUNS_PER_DAY}` + " runs today — the day's ceiling for one bot" };
    return spent;
  }
  if (recentMinute >= TRIGGER_RUNS_PER_MINUTE) {
    let fast: TriggerVerdict = { ok: false,
      reason: "more than " + `${TRIGGER_RUNS_PER_MINUTE}` + " messages in a minute — slow down and they will all be answered" };
    return fast;
  }
  let fine: TriggerVerdict = { ok: true, reason: "" };
  return fine;
}

/** The same row with its day counter moved on, rolling over when the day has
 *  turned. Records are immutable, so "add one" is "build it again". */
export function withRunCounted(bot: TriggerBotRow, nowMs: number): TriggerBotRow {
  let dayStarted = parseInt(bot.dayStartedAt, 10) ?? 0;
  let fresh = (nowMs as int) - dayStarted > 86400000;
  let counted: TriggerBotRow = {
    id: bot.id, owner: bot.owner, kind: bot.kind, name: bot.name,
    workflowId: bot.workflowId, credentialRef: bot.credentialRef,
    offset: bot.offset, leaseBy: bot.leaseBy, leaseUntil: bot.leaseUntil,
    enabled: bot.enabled,
    runsToday: fresh ? 1 : bot.runsToday + 1,
    dayStartedAt: fresh ? `${nowMs}` : bot.dayStartedAt,
    lastAt: `${nowMs}`, lastError: bot.lastError,
    createdAt: bot.createdAt, updatedAt: `${nowMs}`,
  };
  return counted;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function emptyBot(): TriggerBotRow {
  let none: TriggerBotRow = {
    id: "", owner: "", kind: "", name: "", workflowId: "", credentialRef: "",
    offset: "0", leaseBy: "", leaseUntil: "", enabled: false,
    runsToday: 0, dayStartedAt: "", lastAt: "", lastError: "",
    createdAt: "", updatedAt: "",
  };
  return none;
}

/** This owner's bots. */
export function botsOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [asc("name")];
  return listOrdered(db, triggerBotsMapping(), "owner = " + db.placeholder, [owner], keys);
}

/** Whether this update has already been taken in.
 *
 *  The other half of at-least-once: the poller may offer the same update
 *  twice — after a crash between enqueuing and moving the cursor — and this
 *  is what makes the second offer free. */
export function alreadyHave(db: Db, botId: string, updateId: string): bool {
  let rows = JSON.parse<TriggerInboxRow[]>(listWhere(db, triggerInboxMapping(),
    "bot_id = " + db.placeholder + " AND update_id = " + placeholderAt(db, 2),
    [botId, updateId]));
  return rows.length > 0;
}

/** How many runs this bot has started in the last minute. */
export function recentRuns(db: Db, botId: string, nowMs: number): int {
  let since = `${(nowMs as i64) - 60000}`;
  let rows = JSON.parse<TriggerInboxRow[]>(listWhere(db, triggerInboxMapping(),
    "bot_id = " + db.placeholder + " AND created_at > " + placeholderAt(db, 2),
    [botId, since]));
  return rows.length;
}

/** The queue, oldest first — the order messages arrived is the order they
 *  should be answered in. */
export function queuedFor(db: Db, botId: string): string {
  let keys: DbOrder[] = [asc("created_at")];
  return listOrdered(db, triggerInboxMapping(),
    "bot_id = " + db.placeholder + " AND status = " + placeholderAt(db, 2),
    [botId, "queued"], keys);
}

/** Answers that have not been sent back yet, oldest first. */
export function unsentFor(db: Db, botId: string): string {
  let keys: DbOrder[] = [asc("updated_at")];
  return listOrdered(db, triggerInboxMapping(),
    "bot_id = " + db.placeholder + " AND status = " + placeholderAt(db, 2),
    [botId, "done"], keys);
}
