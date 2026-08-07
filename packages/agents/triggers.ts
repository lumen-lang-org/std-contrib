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
import { DbField, DbOrder, DbRepository, asc, createTableSql, desc, field, findById, listOrdered, listWhere, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { jsonList, jsonRaw, jsonText } from "./scan.ts";
import { stampMs } from "./tasks.ts";

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
  // The conversation this chat is having. One per chat rather than one per
  // message: a bot that forgets what was said a minute ago is a search box
  // with extra steps. Carried on the row so the next message can find it
  // without a table of its own.
  threadId: string,
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

// Frozen at what 106.1 created, for the reason threads.ts states about its
// own V1: a migration's text is checksummed, 106.1 generates its CREATE from
// a mapping, and adding a column to the live mapping below rewrites 106.1 —
// so every database that already ran it refuses the whole plan while a fresh
// one migrates happily and nothing in CI notices. This engine spent a restart
// loop proving it. A new column is an ALTER at a new version, never an edit
// to the mapping a shipped migration reads.
function triggerInboxMappingV1(): DbRepository {
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
    field("threadId", "thread_id", "text"),
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
      createTableSql(db, triggerInboxMappingV1())),
    // The column, for a table that already exists on a deployment: 106.1
    // creates it with the column, this adds it where 106.1 already ran.
    // Migrations are history and are never edited in place — the checksum of
    // an applied one is checked on every start.
    migration("106.2", "a chat keeps one conversation",
      "ALTER TABLE trigger_inbox ADD COLUMN thread_id " + db.textType + " NOT NULL DEFAULT ''"),
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
  // stampMs and plain f64 arithmetic, NOT parseInt and `as int`. tasks.ts
  // wrote this trap down and this file fell into it anyway: parseInt answers
  // an i32 and an epoch in milliseconds needs 41 bits, so `nowMs as int` is
  // out of bounds for every real clock — the poller crash-looped on its first
  // pass while every test passed, because the tests used timestamps like
  // 1000. A double carries an integer exactly to 2^53.
  let dayStarted = stampMs(bot.dayStartedAt);
  let fresh = nowMs - dayStarted > 86400000.0;
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
  let dayStarted = stampMs(bot.dayStartedAt);
  let fresh = nowMs - dayStarted > 86400000.0;
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

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** One bot, or an empty row. */
export function botById(db: Db, id: string): TriggerBotRow {
  let doc = findById(db, triggerBotsMapping(), id);
  if (doc == "") { return emptyBot(); }
  return JSON.parse<TriggerBotRow>(doc);
}

/** Take the right to poll this bot, or answer false.
 *
 *  One poller per bot, enforced here rather than by hoping systemd only ever
 *  started one: a second process holding the same token would have both
 *  reading the same updates, and getUpdates hands each update to whoever asks
 *  first — so the two would split a conversation between them at random.
 *
 *  The claim expires. A poller that is killed does not get to make its bot
 *  unpollable forever, which is what a boolean "claimed" column would do. */
export function claimBot(db: Db, botId: string, who: string, nowMs: number): bool {
  let until = `${(nowMs as i64) + (TRIGGER_LEASE_MS as i64)}`;
  let now = `${nowMs}`;
  let sql = "UPDATE trigger_bots SET lease_by = " + db.placeholder
    + ", lease_until = " + placeholderAt(db, 2)
    + " WHERE id = " + placeholderAt(db, 3) + " AND enabled = true"
    // Mine already, or nobody's, or expired. Renewing is the same statement
    // as taking, which is why a poller can call this every pass.
    + " AND (lease_by = " + placeholderAt(db, 4)
    + " OR lease_until = '' OR lease_until < " + placeholderAt(db, 5) + ")"
    // RETURNING rather than an affected-row count: the claims in this package
    // all read their result as rows, and it is the only one plume exposes.
    + " RETURNING id";
  if (!db.query(sql, [who, until, botId, who, now])) { return false; }
  return db.rows() > 0;
}

/** Where the cursor is now, and what the bot last had to say for itself. */
export function noteBotPass(db: Db, botId: string, offset: string, problem: string, nowMs: number): void {
  let sql = "UPDATE trigger_bots SET cursor_offset = " + db.placeholder
    + ", last_at = " + placeholderAt(db, 2)
    + ", last_error = " + placeholderAt(db, 3)
    + ", updated_at = " + placeholderAt(db, 4)
    + " WHERE id = " + placeholderAt(db, 5);
  let now = `${nowMs}`;
  db.query(sql, [offset, now, problem, now, botId]);
}

/** The day counter, written back. Separate from the cursor because the cursor
 *  moves on every pass and this only moves when something ran. */
export function saveBot(db: Db, bot: TriggerBotRow): void {
  persist(db, triggerBotsMapping(), JSON.stringify(bot));
}

/** Take a message in. Answers the row's id, or "" if this update was already
 *  here — the dedupe half of at-least-once delivery. */
export function takeMessage(db: Db, bot: TriggerBotRow, said: TriggerUpdate, nowMs: number): string {
  if (alreadyHave(db, bot.id, said.updateId)) { return ""; }
  let now = `${nowMs}`;
  let row: TriggerInboxRow = {
    id: crypto.randomUUID(), owner: bot.owner, botId: bot.id,
    workflowId: bot.workflowId, updateId: said.updateId, chatId: said.chatId,
    input: said.text, status: "queued", threadId: "", runId: "", answer: "", error: "",
    createdAt: now, updatedAt: now,
  };
  persist(db, triggerInboxMapping(), JSON.stringify(row));
  return row.id;
}

/** A message that was refused rather than queued — over a ceiling, or a bot
 *  switched off between the poll and the check. It is recorded, not dropped:
 *  a person who was told "not now" and can see why is in a different position
 *  from one whose message vanished. */
export function refuseMessage(db: Db, bot: TriggerBotRow, said: TriggerUpdate, why: string, nowMs: number): string {
  if (alreadyHave(db, bot.id, said.updateId)) { return ""; }
  let now = `${nowMs}`;
  let row: TriggerInboxRow = {
    id: crypto.randomUUID(), owner: bot.owner, botId: bot.id,
    workflowId: bot.workflowId, updateId: said.updateId, chatId: said.chatId,
    input: said.text, status: "refused", threadId: "", runId: "", answer: why, error: why,
    createdAt: now, updatedAt: now,
  };
  persist(db, triggerInboxMapping(), JSON.stringify(row));
  return row.id;
}

/** The next queued message, claimed. Any bot's: the scheduler drains one
 *  queue, the same way it claims one due task.
 *
 *  SKIP LOCKED for the reason every other claim in this package uses it — two
 *  passes overlapping must be a second worker taking the next row, not two
 *  workflows firing for one message. */
export function claimMessage(db: Db, nowMs: number): TriggerInboxRow {
  let now = `${nowMs}`;
  let stale = `${(nowMs as i64) - (TRIGGER_LEASE_MS as i64)}`;
  let sql = "UPDATE trigger_inbox SET status = 'running', updated_at = " + db.placeholder
    + " WHERE id = (SELECT id FROM trigger_inbox"
    + " WHERE status = 'queued'"
    // A row left 'running' by a scheduler that died comes back after a lease,
    // rather than sitting claimed forever.
    + " OR (status = 'running' AND updated_at < " + placeholderAt(db, 2) + ")"
    + " ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)"
    + " RETURNING id, owner, bot_id, workflow_id, update_id, chat_id, input, run_id, created_at";
  if (!db.query(sql, [now, stale])) { return emptyMessage(); }
  if (db.rows() == 0) { return emptyMessage(); }
  let got: TriggerInboxRow = {
    id: db.value(0, 0), owner: db.value(0, 1), botId: db.value(0, 2),
    workflowId: db.value(0, 3), updateId: db.value(0, 4), chatId: db.value(0, 5),
    input: db.value(0, 6), status: "running", threadId: "", runId: db.value(0, 7),
    answer: "", error: "", createdAt: db.value(0, 8), updatedAt: now,
  };
  return got;
}

export function emptyMessage(): TriggerInboxRow {
  let none: TriggerInboxRow = {
    id: "", owner: "", botId: "", workflowId: "", updateId: "", chatId: "",
    input: "", status: "", threadId: "", runId: "", answer: "", error: "",
    createdAt: "", updatedAt: "",
  };
  return none;
}

/** What a walk left behind. `done` means there is an answer waiting to be
 *  sent; the poller sends it, because the poller is the process that holds
 *  the token. */
export function finishMessage(db: Db, row: TriggerInboxRow, status: string, runId: string, answer: string, problem: string, nowMs: number): void {
  let sql = "UPDATE trigger_inbox SET status = " + db.placeholder
    + ", run_id = " + placeholderAt(db, 2)
    + ", answer = " + placeholderAt(db, 3)
    + ", error = " + placeholderAt(db, 4)
    + ", updated_at = " + placeholderAt(db, 5)
    + " WHERE id = " + placeholderAt(db, 6);
  db.query(sql, [status, runId, answer, problem, `${nowMs}`, row.id]);
}

/** The conversation this chat is already having, or "".
 *
 *  Looked up per message rather than kept on the bot, because a bot answers
 *  many chats and they are different conversations — the chat id is the
 *  identity, not the bot. */
export function threadForChat(db: Db, botId: string, chatId: string): string {
  let sql = "SELECT thread_id FROM trigger_inbox"
    + " WHERE bot_id = " + db.placeholder
    + " AND chat_id = " + placeholderAt(db, 2)
    + " AND thread_id <> ''"
    + " ORDER BY created_at DESC LIMIT 1";
  if (!db.query(sql, [botId, chatId])) { return ""; }
  if (db.rows() == 0) { return ""; }
  return db.value(0, 0);
}

/** Which conversation a message ended up in. Written when the run opens or
 *  continues one, so the next message from the same chat finds it. */
export function noteThread(db: Db, rowId: string, threadId: string): void {
  db.query("UPDATE trigger_inbox SET thread_id = " + db.placeholder
    + " WHERE id = " + placeholderAt(db, 2), [threadId, rowId]);
}

// ---------------------------------------------------------------------------
// What a person should actually read
// ---------------------------------------------------------------------------

/** An agent's answer with its control blocks taken out.
 *
 *  A reply can carry blocks the console parses and never shows —
 *  `[FOLLOWUPS]{…}[/FOLLOWUPS]` is the common one, `[TEXT]{…}[/TEXT]` is a
 *  card. Every surface that shows an answer has to remove them, and until
 *  today the console was the only surface. A Telegram user was sent the JSON.
 *
 *  The rule is the shape rather than a list of names: `[NAME]…[/NAME]` where
 *  NAME is upper-case. A list would be missing whichever block is added next,
 *  and the failure would again be somebody reading machinery in a chat.
 *
 *  If stripping empties the message the original is sent instead. An ugly
 *  reply is a worse answer than a clean one; no reply at all is not an answer. */
export function plainly(answer: string): string {
  let out = "";
  let rest = answer;
  while (true) {
    let open = rest.indexOf("[");
    if (open < 0) { out = out + rest; break; }
    let shut = rest.indexOf("]", open);
    if (shut < 0) { out = out + rest; break; }
    let name = rest.slice(open + 1, shut);
    if (!isBlockName(name)) {
      // An ordinary bracket — a markdown link, a footnote marker. Kept, and
      // the scan moves past it rather than treating the rest as a block.
      out = out + rest.slice(0, shut + 1);
      rest = rest.slice(shut + 1);
      continue;
    }
    let closer = "[/" + name + "]";
    let ends = rest.indexOf(closer, shut);
    if (ends < 0) {
      // An opening tag with no closing one: the model was cut off mid-block.
      // Everything from here is machinery, and showing half of it is worse
      // than showing none.
      out = out + rest.slice(0, open);
      break;
    }
    out = out + rest.slice(0, open);
    rest = rest.slice(ends + closer.length);
  }
  let clean = out.trim();
  return clean == "" ? answer.trim() : clean;
}

/** Whether these are the letters of a control block's name: upper case, and
 *  at least one of them. */
function isBlockName(name: string): bool {
  if (name.length == 0 || name.length > 24) { return false; }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let upper = c >= 65 && c <= 90;
    let mark = c == 95;
    if (!upper && !mark) { return false; }
    i = i + 1;
  }
  return true;
}
