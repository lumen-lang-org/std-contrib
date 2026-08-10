import { Db } from "../plume/driver.ts";
import { findById, persist, placeholderAt } from "../plume/plume.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { FileToolResult } from "./workspace.ts";
import { jsonRaw, jsonText } from "./scan.ts";
import { TriggerBotRow, botsOf, testingDraft, triggerBotsMapping } from "./triggers.ts";
import { WorkflowRow, workflowsMapping } from "./workflow-store.ts";
import { maySchedule } from "./task-tools.ts";

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

export function triggerTools(): ToolSpec[] {
  let which = "From list_bots. Its name works too when only one bot has it.";
  let out: ToolSpec[] = [];

  out.push(toolSpec("list_bots",
    "The Telegram bots this person keeps: each starts a workflow when a message arrives. "
    + "Shows which workflow, whether it is on, today's run count, and whether a draft test "
    + "window is open. Call it before changing anything.",
    "{\"type\":\"object\",\"properties\":{}}"));

  out.push(toolSpec("change_bot",
    "Switch a bot on or off, rename it, or point it at another workflow. Only what is sent "
    + "changes. Connecting a NEW bot needs its token and happens on the Workflows page — a "
    + "credential does not belong in a conversation.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"bot\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"enabled\":{\"type\":\"boolean\",\"description\":\"true to switch on, false to pause.\"},"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"The workflow it should start, by name or id.\"},"
    + "\"name\":{\"type\":\"string\",\"description\":\"A new label for the list.\"}},"
    + "\"required\":[\"bot\"]}"));

  out.push(toolSpec("test_bot_draft",
    "Point a bot at its workflow's DRAFT for a bounded window — the way to try unpublished "
    + "edits against the real chat. LOUD AND SHORT ON PURPOSE: the stream cannot be split, so "
    + "every message from every chat walks the draft until the window ends, and it always "
    + "ends by itself. {\"minutes\": 0} ends it now.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"bot\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"minutes\":{\"type\":\"number\",\"description\":\"How long, 1 to 30. 0 ends an open window. Left out: 5.\"}},"
    + "\"required\":[\"bot\"]}"));

  return out;
}

export type TriggerToolCall = {
  owner: string,
  name: string,
  args: string,
  nowMs: number,
};

function botSaid(db: Db, owner: string, said: string): TriggerBotRow {
  let rows = JSON.parse<TriggerBotRow[]>(botsOf(db, owner));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].id == said) {
      return rows[i];
    }
    i = i + 1;
  }
  let found: int = -1;
  i = 0;
  while (i < rows.length) {
    if (rows[i].name.toLowerCase() == said.toLowerCase()) {
      if (found >= 0) {
        return emptyish();
      }
      found = i;
    }
    i = i + 1;
  }
  if (found >= 0) {
    return rows[found];
  }
  return emptyish();
}

function emptyish(): TriggerBotRow {
  let none: TriggerBotRow = {
    id: "", owner: "", kind: "", name: "", workflowId: "", credentialRef: "",
    offset: "", leaseBy: "", leaseUntil: "", enabled: false,
    runsToday: 0, dayStartedAt: "", lastAt: "", lastError: "",
    draftUntil: "", createdAt: "", updatedAt: "",
  };
  return none;
}

function workflowSaid(db: Db, owner: string, said: string): WorkflowRow {
  let doc = findById(db, workflowsMapping(), said);
  if (doc != "") {
    let row: WorkflowRow = JSON.parse<WorkflowRow>(doc);
    if (row.owner == owner) {
      return row;
    }
  }
  let sql = "SELECT id FROM workflows WHERE owner = " + db.placeholder
    + " AND LOWER(name) = " + placeholderAt(db, 2);
  if (db.query(sql, [owner, said.toLowerCase()]) && db.rows() == 1) {
    let row2: WorkflowRow = JSON.parse<WorkflowRow>(findById(db, workflowsMapping(), db.value(0, 0)));
    return row2;
  }
  let none: WorkflowRow = {
    id: "", owner: "", agentId: "", modelChoiceId: "", name: "", description: "",
    graph: "", kind: "", cronExpr: "", tz: "", nextAt: "", runningSince: "",
    enabled: false, failures: 0, pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: 0, publishedGraph: "", publishedAt: "", createdAt: "", updatedAt: "",
  };
  return none;
}

export function describeBot(db: Db, bot: TriggerBotRow, nowMs: number): string {
  let flowDoc = findById(db, workflowsMapping(), bot.workflowId);
  let flowName = flowDoc == "" ? bot.workflowId : jsonText(flowDoc, "name");
  let line = bot.name + " [" + bot.id + "]\n"
    + "  " + (bot.enabled ? "on" : "off")
    + " — starts \"" + flowName + "\""
    + ", " + `${bot.runsToday}` + " run(s) today";
  if (testingDraft(bot, nowMs)) {
    line = line + "\n  TESTING THE DRAFT — every message walks unpublished edits until the window ends";
  }
  if (bot.lastError != "") {
    line = line + "\n  last problem: " + bot.lastError;
  }
  return line;
}

export function callTriggerTool(db: Db, call: TriggerToolCall): FileToolResult {
  if (call.name != "list_bots" && call.name != "change_bot" && call.name != "test_bot_draft") {
    return not();
  }
  if (!maySchedule(call.owner)) {
    return no("signing in is what makes a bot theirs to keep — say so.");
  }

  if (call.name == "list_bots") {
    let rows = JSON.parse<TriggerBotRow[]>(botsOf(db, call.owner));
    if (rows.length == 0) {
      return yes("No bots yet. Connecting one takes its BotFather token, which belongs on the Workflows page, not in a conversation.");
    }
    let out = `${rows.length}` + " bot(s):\n";
    let i: int = 0;
    while (i < rows.length) {
      out = out + "\n" + describeBot(db, rows[i], call.nowMs) + "\n";
      i = i + 1;
    }
    return yes(out);
  }

  let said = jsonText(call.args, "bot").trim();
  if (said == "") {
    return no("say which bot: {\"bot\":\"...\"} — list_bots shows them.");
  }
  let bot = botSaid(db, call.owner, said);
  if (bot.id == "") {
    return no("no bot by that name or id — list_bots shows them.");
  }

  if (call.name == "change_bot") {
    let flowSaid = jsonText(call.args, "workflow").trim();
    let workflowId = bot.workflowId;
    let note = "";
    if (flowSaid != "") {
      let flow = workflowSaid(db, call.owner, flowSaid);
      if (flow.id == "") {
        return no("no workflow called \"" + flowSaid + "\" — list_workflows shows them.");
      }
      workflowId = flow.id;
      if ((flow.publishedGraph ?? "") == "" && flow.graph == "") {
        return no("\"" + flow.name + "\" has nothing to run yet.");
      }
      note = " It now starts \"" + flow.name + "\".";
    }
    let name = jsonText(call.args, "name").trim();
    let enabledRaw = jsonRaw(call.args, "enabled").trim();
    let enabled = enabledRaw == "" ? bot.enabled : enabledRaw == "true";
    let edited: TriggerBotRow = {
      id: bot.id, owner: bot.owner, kind: bot.kind,
      name: name == "" ? bot.name : name,
      workflowId: workflowId,
      credentialRef: bot.credentialRef, offset: bot.offset,
      leaseBy: bot.leaseBy, leaseUntil: bot.leaseUntil,
      enabled: enabled,
      runsToday: bot.runsToday, dayStartedAt: bot.dayStartedAt,
      lastAt: bot.lastAt, lastError: bot.lastError,
      draftUntil: bot.draftUntil ?? "",
      createdAt: bot.createdAt, updatedAt: `${call.nowMs}`,
    };
    persist(db, triggerBotsMapping(), JSON.stringify(edited));
    let word = enabled == bot.enabled ? "Changed." : enabled ? "On." : "Paused.";
    return yes(word + note + "\n\n" + describeBot(db, edited, call.nowMs));
  }

  let minutes = parseInt(jsonRaw(call.args, "minutes").trim(), 10) ?? 5;
  if (minutes < 0) {
    minutes = 0;
  }
  if (minutes > 30) {
    minutes = 30;
  }
  let until = minutes == 0 ? "" : `${(call.nowMs as i64) + (minutes as i64) * 60000}`;
  let sql = "UPDATE trigger_bots SET draft_until = " + db.placeholder
    + ", updated_at = " + placeholderAt(db, 2)
    + " WHERE id = " + placeholderAt(db, 3);
  db.query(sql, [until, `${call.nowMs}`, bot.id]);
  if (minutes == 0) {
    return yes("Window closed — " + bot.name + " serves the published version again.");
  }
  return yes("For the next " + `${minutes}` + " minute(s), EVERY message to " + bot.name
    + " walks the workflow's draft. It reverts by itself; {\"minutes\": 0} ends it sooner.");
}
