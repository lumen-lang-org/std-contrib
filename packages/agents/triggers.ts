import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, createTableSql, field, findById, listOrdered, listWhere, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { triggerBotRepository } from "./routes/triggers/entities/trigger-bot.entity.ts";
import { triggerInboxRepository } from "./routes/triggers/entities/trigger-inbox.entity.ts";
import { jsonList, jsonRaw, jsonText } from "./scan.ts";
import { stampMs } from "./tasks.ts";

export const TRIGGER_RUNS_PER_DAY: int = 200;
export const TRIGGER_RUNS_PER_MINUTE: int = 6;
export const TRIGGER_LEASE_MS: int = 90000;
export const TRIGGER_INPUT_MAX: int = 8000;

export type TriggerBotRow = {
  id: string,
  owner: string,
  kind: string,
  name: string,
  workflowId: string,
  credentialRef: string,
  offset: string,
  leaseBy: string,
  leaseUntil: string,
  enabled: bool,
  runsToday: int,
  dayStartedAt: string,
  lastAt: string,
  lastError: string,
  draftUntil?: string,
  createdAt: string,
  updatedAt: string,
};

export type TriggerInboxRow = {
  id: string,
  owner: string,
  botId: string,
  workflowId: string,
  updateId: string,
  chatId: string,
  input: string,
  status: string,
  threadId: string,
  fileName?: string,
  fileBody?: string,
  speaker?: string,
  runId: string,
  answer: string,
  error: string,
  createdAt: string,
  updatedAt: string,
};

function triggerBotsMappingV1(): DbRepository {
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
  return repository({ table: "trigger_bots", idField: "id", idColumn: "id", fields: fs });
}

export function triggerBotsMapping(): DbRepository {
  return triggerBotRepository();
}

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
  return repository({ table: "trigger_inbox", idField: "id", idColumn: "id", fields: fs });
}

export function triggerInboxMapping(): DbRepository {
  return triggerInboxRepository();
}

export type TriggerOutboxRow = {
  id: string,
  botId: string,
  chatId: string,
  runId: string,
  text: string,
  status: string,
  options?: string,
  fileThread?: string,
  filePath?: string,
  createdAt: string,
  updatedAt: string,
};

function triggerOutboxMappingV1(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("botId", "bot_id", "text"),
    field("chatId", "chat_id", "text"),
    field("runId", "run_id", "text"),
    field("text", "text", "text"),
    field("status", "status", "text"),
    field("createdAt", "created_at", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository({ table: "trigger_outbox", idField: "id", idColumn: "id", fields: fs });
}

export function triggerOutboxMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("botId", "bot_id", "text"),
    field("chatId", "chat_id", "text"),
    field("runId", "run_id", "text"),
    field("text", "text", "text"),
    field("status", "status", "text"),
    field("options", "options", "text"),
    field("fileThread", "file_thread", "text"),
    field("filePath", "file_path", "text"),
    field("createdAt", "created_at", "text"),
    field("updatedAt", "updated_at", "text"),
  ];
  return repository({ table: "trigger_outbox", idField: "id", idColumn: "id", fields: fs });
}

export type TriggerPendingRow = {
  id: string,
  botId: string,
  chatId: string,
  workflowId: string,
  runId: string,
  nodeId: string,
  graph: string,
  input: string,
  outputs: string,
  threadId: string,
  expiresAt: string,
  createdAt: string,
};

export function triggerPendingMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("botId", "bot_id", "text"),
    field("chatId", "chat_id", "text"),
    field("workflowId", "workflow_id", "text"),
    field("runId", "run_id", "text"),
    field("nodeId", "node_id", "text"),
    field("graph", "graph", "text"),
    field("input", "input", "text"),
    field("outputs", "outputs", "text"),
    field("threadId", "thread_id", "text"),
    field("expiresAt", "expires_at", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository({ table: "trigger_pending", idField: "id", idColumn: "id", fields: fs });
}

export const TRIGGER_ASK_TTL_MS: int = 1800000;

export function triggersPlan(db: Db): Migration[] {
  return [
    migration("106", "triggers: workflows started by something arriving",
      createTableSql(db, triggerBotsMappingV1())),
    migration("106.1", "and what arrived",
      createTableSql(db, triggerInboxMappingV1())),
    migration("106.2", "a chat keeps one conversation",
      "ALTER TABLE trigger_inbox ADD COLUMN thread_id " + db.textType + " NOT NULL DEFAULT ''"),
    migration("106.3", "what a run says before it is done",
      createTableSql(db, triggerOutboxMappingV1())),
    migration("107.3", "a bounded window where a bot tests the draft",
      "ALTER TABLE trigger_bots ADD COLUMN draft_until " + db.textType + " NOT NULL DEFAULT ''"),
    migration("107.4", "a question waiting for its chat to answer",
      createTableSql(db, triggerPendingMapping())),
    migration("107.5", "a question can offer its answers as buttons",
      "ALTER TABLE trigger_outbox ADD COLUMN options " + db.textType + " NOT NULL DEFAULT ''"),
    migration("107.6", "a message can carry a document, parked for the walk",
      "ALTER TABLE trigger_inbox ADD COLUMN file_name " + db.textType + " NOT NULL DEFAULT ''"),
    migration("107.7", "and its bytes",
      "ALTER TABLE trigger_inbox ADD COLUMN file_body " + db.textType + " NOT NULL DEFAULT ''"),
    migration("107.8", "who spoke, in a group",
      "ALTER TABLE trigger_inbox ADD COLUMN speaker " + db.textType + " NOT NULL DEFAULT ''"),
    migration("107.9", "a reply can send a document: where it lives",
      "ALTER TABLE trigger_outbox ADD COLUMN file_thread " + db.textType + " NOT NULL DEFAULT ''"),
    migration("108", "and its path there",
      "ALTER TABLE trigger_outbox ADD COLUMN file_path " + db.textType + " NOT NULL DEFAULT ''"),
  ];
}

export type TriggerUpdate = {
  updateId: string,
  chatId: string,
  text: string,
  fileId: string,
  fileName: string,
  fileSize: number,
  speaker: string,
};

export function updatesIn(body: string): TriggerUpdate[] {
  let out: TriggerUpdate[] = [];
  if (jsonRaw(body, "ok").trim() != "true") {
    return out;
  }
  let each = jsonList(jsonRaw(body, "result"));
  let i: int = 0;
  while (i < each.length) {
    let one = each[i];
    let id = jsonRaw(one, "update_id").trim();
    let message = jsonRaw(one, "message");
    if (id != "" && message != "") {
      let chat = jsonRaw(message, "chat");
      let chatId = chat == "" ? "" : jsonRaw(chat, "id").trim();
      let text = jsonText(message, "text");
      let doc = jsonRaw(message, "document");
      let fileId = doc == "" ? "" : jsonText(doc, "file_id");
      let fileName = doc == "" ? "" : jsonText(doc, "file_name");
      let fileSize = doc == "" ? 0.0 : (parseFloat(jsonRaw(doc, "file_size").trim()) ?? 0.0);
      if (doc != "" && text.trim() == "") {
        text = jsonText(message, "caption");
      }
      let kind = chat == "" ? "" : jsonText(chat, "type");
      let who = "";
      if (kind != "" && kind != "private") {
        let from = jsonRaw(message, "from");
        who = from == "" ? "" : jsonText(from, "first_name");
        if (who == "") {
          who = from == "" ? "" : jsonText(from, "username");
        }
      }
      if (chatId != "" && (text.trim() != "" || fileId != "")) {
        let said: TriggerUpdate = { updateId: id, chatId: chatId,
          text: text.length > TRIGGER_INPUT_MAX ? text.slice(0, TRIGGER_INPUT_MAX) : text,
          fileId: fileId, fileName: fileName == "" && fileId != "" ? "document" : fileName,
          fileSize: fileSize, speaker: who };
        out.push(said);
      }
    }
    i = i + 1;
  }
  return out;
}

export function nextOffset(seen: TriggerUpdate[], now: string): string {
  let highest: int = parseInt(now, 10) ?? 0;
  let i: int = 0;
  while (i < seen.length) {
    let id = parseInt(seen[i].updateId, 10) ?? 0;
    if (id >= highest) {
      highest = id + 1;
    }
    i = i + 1;
  }
  return `${highest}`;
}

export type TriggerVerdict = {
  ok: bool,
  reason: string,
};

export function mayRun(bot: TriggerBotRow, recentMinute: int, nowMs: number): TriggerVerdict {
  if (!bot.enabled) {
    let off: TriggerVerdict = { ok: false, reason: "this bot is switched off" };
    return off;
  }
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
    draftUntil: bot.draftUntil ?? "",
    createdAt: bot.createdAt, updatedAt: `${nowMs}`,
  };
  return counted;
}

export function emptyBot(): TriggerBotRow {
  let none: TriggerBotRow = {
    id: "", owner: "", kind: "", name: "", workflowId: "", credentialRef: "",
    offset: "0", leaseBy: "", leaseUntil: "", enabled: false,
    runsToday: 0, dayStartedAt: "", lastAt: "", lastError: "",
    draftUntil: "", createdAt: "", updatedAt: "",
  };
  return none;
}

export function botsOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [{ column: "name" }];
  return listOrdered(db, triggerBotsMapping(), {
    where: "owner = " + db.placeholder,
    args: [owner],
    order: keys,
  });
}

export function alreadyHave(db: Db, botId: string, updateId: string): bool {
  let rows = JSON.parse<TriggerInboxRow[]>(listWhere(db, triggerInboxMapping(),
    "bot_id = " + db.placeholder + " AND update_id = " + placeholderAt(db, 2),
    [botId, updateId]));
  return rows.length > 0;
}

export function recentRuns(db: Db, botId: string, nowMs: number): int {
  let since = `${(nowMs as i64) - 60000}`;
  let rows = JSON.parse<TriggerInboxRow[]>(listWhere(db, triggerInboxMapping(),
    "bot_id = " + db.placeholder + " AND created_at > " + placeholderAt(db, 2),
    [botId, since]));
  return rows.length;
}

export function queuedFor(db: Db, botId: string): string {
  let keys: DbOrder[] = [{ column: "created_at" }];
  return listOrdered(db, triggerInboxMapping(), {
    where: "bot_id = " + db.placeholder + " AND status = " + placeholderAt(db, 2),
    args: [botId, "queued"],
    order: keys,
  });
}

export function unsentFor(db: Db, botId: string): string {
  let keys: DbOrder[] = [{ column: "updated_at" }];
  return listOrdered(db, triggerInboxMapping(), {
    where: "bot_id = " + db.placeholder + " AND status = " + placeholderAt(db, 2),
    args: [botId, "done"],
    order: keys,
  });
}

export function botById(db: Db, id: string): TriggerBotRow {
  let doc = findById(db, triggerBotsMapping(), id);
  if (doc == "") {
    return emptyBot();
  }
  return JSON.parse<TriggerBotRow>(doc);
}

export function claimBot(db: Db, botId: string, who: string, nowMs: number): bool {
  let until = `${(nowMs as i64) + (TRIGGER_LEASE_MS as i64)}`;
  let now = `${nowMs}`;
  let sql = "UPDATE trigger_bots SET lease_by = " + db.placeholder
    + ", lease_until = " + placeholderAt(db, 2)
    + " WHERE id = " + placeholderAt(db, 3) + " AND enabled = true"
    + " AND (lease_by = " + placeholderAt(db, 4)
    + " OR lease_until = '' OR lease_until < " + placeholderAt(db, 5) + ")"
    + " RETURNING id";
  if (!db.query(sql, [who, until, botId, who, now])) {
    return false;
  }
  return db.rows() > 0;
}

export function noteBotPass(db: Db, botId: string, offset: string, fault: string, nowMs: number): void {
  let sql = "UPDATE trigger_bots SET cursor_offset = " + db.placeholder
    + ", last_at = " + placeholderAt(db, 2)
    + ", last_error = " + placeholderAt(db, 3)
    + ", updated_at = " + placeholderAt(db, 4)
    + " WHERE id = " + placeholderAt(db, 5);
  let now = `${nowMs}`;
  db.query(sql, [offset, now, fault, now, botId]);
}

export function saveBot(db: Db, bot: TriggerBotRow): void {
  persist(db, triggerBotsMapping(), JSON.stringify(bot));
}

export function takeMessage(db: Db, bot: TriggerBotRow, said: TriggerUpdate, nowMs: number): string {
  if (alreadyHave(db, bot.id, said.updateId)) {
    return "";
  }
  let now = `${nowMs}`;
  let row: TriggerInboxRow = {
    id: crypto.randomUUID(), owner: bot.owner, botId: bot.id,
    workflowId: bot.workflowId, updateId: said.updateId, chatId: said.chatId,
    input: said.text, status: "queued", threadId: "",
    fileName: "", fileBody: "", speaker: said.speaker,
    runId: "", answer: "", error: "",
    createdAt: now, updatedAt: now,
  };
  let written = persist(db, triggerInboxMapping(), JSON.stringify(row));
  if (!written.ok) {
    return "";
  }
  return row.id;
}

export function refuseMessage(db: Db, bot: TriggerBotRow, said: TriggerUpdate, why: string, nowMs: number): string {
  if (alreadyHave(db, bot.id, said.updateId)) {
    return "";
  }
  let now = `${nowMs}`;
  let row: TriggerInboxRow = {
    id: crypto.randomUUID(), owner: bot.owner, botId: bot.id,
    workflowId: bot.workflowId, updateId: said.updateId, chatId: said.chatId,
    input: said.text, status: "refused", threadId: "",
    fileName: "", fileBody: "", speaker: said.speaker,
    runId: "", answer: why, error: why,
    createdAt: now, updatedAt: now,
  };
  let written = persist(db, triggerInboxMapping(), JSON.stringify(row));
  if (!written.ok) {
    return "";
  }
  return row.id;
}

export function claimMessage(db: Db, nowMs: number): TriggerInboxRow {
  let now = `${nowMs}`;
  let stale = `${(nowMs as i64) - (TRIGGER_LEASE_MS as i64)}`;
  let sql = "UPDATE trigger_inbox SET status = 'running', updated_at = " + db.placeholder
    + " WHERE id = (SELECT id FROM trigger_inbox"
    + " WHERE status = 'queued'"
    + " OR (status = 'running' AND updated_at < " + placeholderAt(db, 2) + ")"
    + " ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)"
    + " RETURNING id, owner, bot_id, workflow_id, update_id, chat_id, input, run_id, created_at, file_name, file_body, thread_id, speaker";
  if (!db.query(sql, [now, stale])) {
    return emptyMessage();
  }
  if (db.rows() == 0) {
    return emptyMessage();
  }
  let got: TriggerInboxRow = {
    id: db.value(0, 0), owner: db.value(0, 1), botId: db.value(0, 2),
    workflowId: db.value(0, 3), updateId: db.value(0, 4), chatId: db.value(0, 5),
    input: db.value(0, 6), status: "running", threadId: db.value(0, 11),
    fileName: db.value(0, 9), fileBody: db.value(0, 10),
    speaker: db.value(0, 12),
    runId: db.value(0, 7),
    answer: "", error: "", createdAt: db.value(0, 8), updatedAt: now,
  };
  return got;
}

export function emptyMessage(): TriggerInboxRow {
  let none: TriggerInboxRow = {
    id: "", owner: "", botId: "", workflowId: "", updateId: "", chatId: "",
    input: "", status: "", threadId: "", fileName: "", fileBody: "", speaker: "",
    runId: "", answer: "", error: "",
    createdAt: "", updatedAt: "",
  };
  return none;
}

export function finishMessage(db: Db, row: TriggerInboxRow, status: string, runId: string, answer: string, fault: string, nowMs: number): void {
  let sql = "UPDATE trigger_inbox SET status = " + db.placeholder
    + ", run_id = " + placeholderAt(db, 2)
    + ", answer = " + placeholderAt(db, 3)
    + ", error = " + placeholderAt(db, 4)
    + ", updated_at = " + placeholderAt(db, 5)
    + " WHERE id = " + placeholderAt(db, 6);
  db.query(sql, [status, runId, answer, fault, `${nowMs}`, row.id]);
}

export function parkFile(db: Db, rowId: string, fileName: string, fileBody: string): void {
  db.query("UPDATE trigger_inbox SET file_name = " + db.placeholder
    + ", file_body = " + placeholderAt(db, 2)
    + " WHERE id = " + placeholderAt(db, 3), [fileName, fileBody, rowId]);
}

export function queueOutbound(db: Db, botId: string, chatId: string, runId: string, text: string, nowMs: number): string {
  return queueOutboundWith(db, botId, chatId, runId, text, "", nowMs);
}

export function queueOutboundWith(db: Db, botId: string, chatId: string, runId: string, text: string, options: string, nowMs: number): string {
  let now = `${nowMs}`;
  let row: TriggerOutboxRow = {
    id: crypto.randomUUID(), botId: botId, chatId: chatId, runId: runId,
    text: plainly(text), status: "queued", options: options.trim(),
    fileThread: "", filePath: "",
    createdAt: now, updatedAt: now,
  };
  let written = persist(db, triggerOutboxMapping(), JSON.stringify(row));
  if (!written.ok) {
    return "";
  }
  return row.id;
}

export function queueOutboundFile(db: Db, botId: string, chatId: string, runId: string, caption: string, fileThread: string, filePath: string, nowMs: number): string {
  let now = `${nowMs}`;
  let row: TriggerOutboxRow = {
    id: crypto.randomUUID(), botId: botId, chatId: chatId, runId: runId,
    text: plainly(caption), status: "queued", options: "",
    fileThread: fileThread, filePath: filePath,
    createdAt: now, updatedAt: now,
  };
  let written = persist(db, triggerOutboxMapping(), JSON.stringify(row));
  if (!written.ok) {
    return "";
  }
  return row.id;
}

type KeyboardKey = {
  text: string,
};

type ReplyKeyboardView = {
  keyboard: KeyboardKey[][],
  one_time_keyboard: bool,
  resize_keyboard: bool,
};

function keyRow(one: string): KeyboardKey[] {
  let key: KeyboardKey = { text: one };
  let row: KeyboardKey[] = [key];
  return row;
}

export function replyKeyboard(options: string): string {
  let said: string[] = [];
  let lines = options.split("\n");
  let i: int = 0;
  while (i < lines.length) {
    let one = lines[i].trim();
    if (one != "") {
      said.push(one);
    }
    i = i + 1;
  }
  if (said.length == 0) {
    return "";
  }
  let board: ReplyKeyboardView = {
    keyboard: said.map(keyRow),
    one_time_keyboard: true,
    resize_keyboard: true,
  };
  return JSON.stringify(board);
}

export function unsentOutbound(db: Db, botId: string): string {
  let keys: DbOrder[] = [{ column: "created_at" }];
  return listOrdered(db, triggerOutboxMapping(), {
    where: "bot_id = " + db.placeholder + " AND status = " + placeholderAt(db, 2),
    args: [botId, "queued"],
    order: keys,
  });
}

export function testingDraft(bot: TriggerBotRow, nowMs: number): bool {
  let until = stampMs(bot.draftUntil ?? "");
  return until > nowMs;
}

export function markOutboundSent(db: Db, id: string, nowMs: number): void {
  db.query("UPDATE trigger_outbox SET status = 'sent', updated_at = " + db.placeholder
    + " WHERE id = " + placeholderAt(db, 2), [`${nowMs}`, id]);
}

export function pendingFor(db: Db, botId: string, chatId: string, nowMs: number): TriggerPendingRow {
  let rows = JSON.parse<TriggerPendingRow[]>(listWhere(db, triggerPendingMapping(),
    "bot_id = " + db.placeholder + " AND chat_id = " + placeholderAt(db, 2),
    [botId, chatId]));
  if (rows.length == 0) {
    return emptyPending();
  }
  let held = rows[0];
  if (stampMs(held.expiresAt) <= nowMs) {
    db.query("DELETE FROM trigger_pending WHERE id = " + db.placeholder, [held.id]);
    return emptyPending();
  }
  return held;
}

export function rememberAsk(db: Db, row: TriggerPendingRow): void {
  db.query("DELETE FROM trigger_pending WHERE bot_id = " + db.placeholder
    + " AND chat_id = " + placeholderAt(db, 2), [row.botId, row.chatId]);
  persist(db, triggerPendingMapping(), JSON.stringify(row));
}

export function forgetAsk(db: Db, id: string): void {
  db.query("DELETE FROM trigger_pending WHERE id = " + db.placeholder, [id]);
}

export function emptyPending(): TriggerPendingRow {
  let none: TriggerPendingRow = {
    id: "", botId: "", chatId: "", workflowId: "", runId: "", nodeId: "",
    graph: "", input: "", outputs: "", threadId: "", expiresAt: "", createdAt: "",
  };
  return none;
}

export function threadForChat(db: Db, botId: string, chatId: string): string {
  let sql = "SELECT thread_id FROM trigger_inbox"
    + " WHERE bot_id = " + db.placeholder
    + " AND chat_id = " + placeholderAt(db, 2)
    + " AND thread_id <> ''"
    + " ORDER BY created_at DESC LIMIT 1";
  if (!db.query(sql, [botId, chatId])) {
    return "";
  }
  if (db.rows() == 0) {
    return "";
  }
  return db.value(0, 0);
}

export function noteThread(db: Db, rowId: string, threadId: string): void {
  db.query("UPDATE trigger_inbox SET thread_id = " + db.placeholder
    + " WHERE id = " + placeholderAt(db, 2), [threadId, rowId]);
}

export function plainly(answer: string): string {
  let out = "";
  let rest = answer;
  while (true) {
    let open = rest.indexOf("[");
    if (open < 0) {
      out = out + rest;
      break;
    }
    let shut = rest.indexOf("]", open);
    if (shut < 0) {
      out = out + rest;
      break;
    }
    let name = rest.slice(open + 1, shut);
    if (!isBlockName(name)) {
      out = out + rest.slice(0, shut + 1);
      rest = rest.slice(shut + 1);
      continue;
    }
    let closer = "[/" + name + "]";
    let ends = rest.indexOf(closer, shut);
    if (ends < 0) {
      out = out + rest.slice(0, open);
      break;
    }
    out = out + rest.slice(0, open);
    rest = rest.slice(ends + closer.length);
  }
  let clean = out.trim();
  return clean == "" ? answer.trim() : clean;
}

export function fileBlock(answer: string): string {
  let open = answer.indexOf("[FILE]");
  if (open < 0) {
    return "";
  }
  let shut = answer.indexOf("[/FILE]", open + 6);
  if (shut < 0) {
    return "";
  }
  return answer.slice(open + 6, shut).trim();
}

function isBlockName(name: string): bool {
  if (name.length == 0 || name.length > 24) {
    return false;
  }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let upper = c >= 65 && c <= 90;
    let mark = c == 95;
    if (!upper && !mark) {
      return false;
    }
    i = i + 1;
  }
  return true;
}
