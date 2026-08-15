import { Db } from "../plume/driver.ts";
import { deleteById, executeWith, findById, listWhere, persist, placeholderAt } from "../plume/plume.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { FileToolResult } from "./workspace.ts";
import { jsonFlag, jsonList, jsonRaw, jsonText } from "./scan.ts";
import { maySchedule } from "./task-tools.ts";
import { civil, knownZone } from "../cron/cron.ts";
import { WfEdge, WfGraph, WfNode, WfView, casesOf, emptyNode, refuse as refuseGraph, secretIds, startOf } from "../workflow/workflow.ts";
import { MAX_WORKFLOWS_PER_OWNER, WorkflowRow, WorkflowRunRow, emptyWorkflow, enabledWorkflowCount, nextWorkflowFire, parseGraph, refuseWorkflow, timingOf, withWorkflowNextAt, workflowRunsMapping, workflowsMapping } from "./workflow-store.ts";
import { SecretRepository } from "./routes/identity/secrets/secret.repository.ts";
import { SecretRow } from "./routes/identity/secrets/secret.utils.ts";
import { stampMs } from "./tasks.ts";

const SAID_KINDS = "\\\"agent\\\" (a full agent turn with its tools), \\\"model\\\" (one model call, no tools), "
  + "\\\"web_search\\\" (the deployment's web index), \\\"knowledge\\\" (the agent's documents), "
  + "\\\"http\\\" (fetch a url), \\\"script\\\" (compiled Lumen, run sandboxed), "
  + "\\\"reply\\\" (say text to the Telegram chat mid-walk and keep going), "
  + "\\\"ask\\\" (ask the Telegram chat and STOP until they answer; give options and they become tap buttons), "
  + "\\\"connector\\\" (call one tool on a connected server such as linear), "
  + "\\\"switch\\\" (route on the previous step's answer — give cases, one per line; every branch first "
  + "points at the next step, and connect_steps re-points each case)";
const KINDS_SENTENCE = "the kinds are agent, model, web_search, knowledge, http, script, reply, ask, connector and switch";

export type WorkflowToolCall = {
  owner: string,
  agentId: string,
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

export function workflowTools(): ToolSpec[] {
  let schedule = "How often, in words, or leave it out for a workflow run by hand. "
    + "Repeating: \\\"every day at 07:30\\\", \\\"every weekday at 08:00\\\", \\\"every 30 minutes\\\", \\\"every 6 hours\\\". "
    + "Once: \\\"on 2026-08-06 at 09:00\\\". Times are HH:MM on a 24-hour clock.";
  let zone = "The IANA timezone the person's clock is in, such as Europe/Paris. "
    + "Leave it out unless they have said where they are.";
  let which = "From list_workflows. Its name works too when only one workflow has it.";
  let step = "The step's id from show_workflow. Its name works too when only one step has it.";

  let out: ToolSpec[] = [];
  out.push(toolSpec("list_workflows",
    "The workflows this person keeps: multi-step pipelines drawn on a canvas — steps connected by edges, "
    + "run on a schedule or by hand. Call it before changing anything, and before drafting something "
    + "that sounds like it already exists. For a single repeating instruction with no steps, prefer schedule_task.",
    "{\"type\":\"object\",\"properties\":{}}"));

  out.push(toolSpec("show_workflow",
    "One workflow in full: each step in order with its id, what it does, how they connect, "
    + "the schedule, and how the last runs went.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"}},"
    + "\"required\":[\"workflow\"]}"));

  out.push(toolSpec("draft_workflow",
    "Create a workflow from a description: a name and the steps in order. The steps become a chain — "
    + "first to last, then the answer — which the person can open on the Workflows page and rearrange, "
    + "branch or reschedule by hand. Each run opens a conversation of its own with the result. "
    + "Steps run in order and each sees the previous step's output; write {{prev}} in a step's text to "
    + "use it, or {{node.<id>}} for an earlier one. "
    + "A person may keep " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"name\":{\"type\":\"string\",\"description\":\"A few words for the list, such as \\\"Morning brief\\\".\"},"
    + "\"description\":{\"type\":\"string\",\"description\":\"One line on what it is for.\"},"
    + "\"steps\":{\"type\":\"array\",\"description\":\"The steps, in the order they run.\",\"items\":{\"type\":\"object\",\"properties\":{"
    + "\"kind\":{\"type\":\"string\",\"description\":\"One of " + SAID_KINDS + ".\"},"
    + "\"text\":{\"type\":\"string\",\"description\":\"What the step does: the instruction for agent or model, the query for web_search or knowledge, the url for http (GET).\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"A short label for the canvas, such as \\\"Search the news\\\".\"},"
    + "\"options\":{\"type\":\"string\",\"description\":\"ask only: the choices offered as tap buttons, one per line.\"},"
    + "\"cases\":{\"type\":\"string\",\"description\":\"switch only: the values it routes on, one per line.\"},"
    + "\"server\":{\"type\":\"string\",\"description\":\"connector only: the server id, from the Connectors page — such as linear.\"},"
    + "\"tool\":{\"type\":\"string\",\"description\":\"connector only: the tool to call on it.\"},"
    + "\"arguments\":{\"type\":\"object\",\"description\":\"connector only: the tool's arguments; {{prev}} and {{input}} fill in.\"},"
    + "\"file\":{\"type\":\"string\",\"description\":\"reply only: an artifact path to send as a document, such as /report.md — the text becomes its caption. Leave out to send text alone, or when an earlier agent step names the file itself by writing [FILE]/report.md[/FILE] in its answer.\"}},"
    + "\"required\":[\"kind\",\"text\"]}},"
    + "\"schedule\":{\"type\":\"string\",\"description\":\"" + schedule + "\"},"
    + "\"timezone\":{\"type\":\"string\",\"description\":\"" + zone + "\"}},"
    + "\"required\":[\"name\",\"steps\"]}"));

  out.push(toolSpec("connect_steps",
    "Point an edge: make one step lead to another. For a switch or condition, say which branch — "
    + "the case's own text (or \\\"else\\\", or \\\"yes\\\"/\\\"no\\\") — and that branch is re-pointed; "
    + "other branches stay. Without a branch, the step's plain way out is re-pointed.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"from\":{\"type\":\"string\",\"description\":\"" + step + "\"},"
    + "\"to\":{\"type\":\"string\",\"description\":\"" + step + "\"},"
    + "\"branch\":{\"type\":\"string\",\"description\":\"For a switch: which case. For a condition: yes or no. Leave out otherwise.\"}},"
    + "\"required\":[\"workflow\",\"from\",\"to\"]}"));

  out.push(toolSpec("publish_workflow",
    "Make the workflow's current draft what production runs. Edits made here land in the DRAFT: "
    + "runs a person starts by hand use it at once, but messages and the clock keep running the "
    + "version last published — so after changing a workflow a bot serves, publish it, and say so.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"}},"
    + "\"required\":[\"workflow\"]}"));

  out.push(toolSpec("add_step",
    "Add one step to a workflow's chain. It is spliced in after the step named — or just before the "
    + "end when none is named. A workflow that branches at that point has to be rearranged on the "
    + "Workflows page instead.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"kind\":{\"type\":\"string\",\"description\":\"One of " + SAID_KINDS + ".\"},"
    + "\"text\":{\"type\":\"string\",\"description\":\"What the step does. {{prev}} is the previous step's output.\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"A short label for the canvas.\"},"
    + "\"options\":{\"type\":\"string\",\"description\":\"ask only: the choices offered as tap buttons, one per line.\"},"
    + "\"cases\":{\"type\":\"string\",\"description\":\"switch only: the values it routes on, one per line.\"},"
    + "\"server\":{\"type\":\"string\",\"description\":\"connector only: the server id — such as linear.\"},"
    + "\"tool\":{\"type\":\"string\",\"description\":\"connector only: the tool to call on it.\"},"
    + "\"arguments\":{\"type\":\"object\",\"description\":\"connector only: the tool's arguments; {{prev}} and {{input}} fill in.\"},"
    + "\"file\":{\"type\":\"string\",\"description\":\"reply only: an artifact path to send as a document — the text becomes its caption. An earlier agent step may instead name the file at run time with [FILE]/report.md[/FILE] in its answer.\"},"
    + "\"after\":{\"type\":\"string\",\"description\":\"" + step + " Leave out to add before the end.\"}},"
    + "\"required\":[\"workflow\",\"kind\",\"text\"]}"));

  out.push(toolSpec("change_step",
    "Change what one step does or what it is called. Only what is sent changes.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"step\":{\"type\":\"string\",\"description\":\"" + step + "\"},"
    + "\"text\":{\"type\":\"string\",\"description\":\"The new instruction, query or url — whole, for the kind of step it is.\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"A new label for the canvas.\"},"
    + "\"file\":{\"type\":\"string\",\"description\":\"reply only: an artifact path to send as a document. \\\"none\\\" takes it away.\"},"
    + "\"secret\":{\"type\":\"string\",\"description\":\"The name of a stored secret this step may send, or several separated by commas — list_secrets says which exist. \\\"none\\\" detaches them. Values are never typed here.\"}},"
    + "\"required\":[\"workflow\",\"step\"]}"));

  out.push(toolSpec("list_secrets",
    "The stored secrets an http step can send: names, which header each fills, and the one address "
    + "each may be sent to. Never their values — a secret is written once, on the Workflows page or "
    + "in Settings, and can only be attached or deleted after that.",
    "{\"type\":\"object\",\"properties\":{}}"));

  out.push(toolSpec("remove_step",
    "Take one step out of a workflow's chain, joining the steps around it. START and END stay; "
    + "a step that branches has to be removed on the Workflows page instead.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"step\":{\"type\":\"string\",\"description\":\"" + step + "\"}},"
    + "\"required\":[\"workflow\",\"step\"]}"));

  out.push(toolSpec("schedule_workflow",
    "Set when a workflow runs by itself, or take its schedule away. "
    + "The reply names the next firing in the person's own zone; say that back to them.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"schedule\":{\"type\":\"string\",\"description\":\"" + schedule + " \\\"manual\\\" takes the schedule away.\"},"
    + "\"timezone\":{\"type\":\"string\",\"description\":\"" + zone + "\"}},"
    + "\"required\":[\"workflow\",\"schedule\"]}"));

  out.push(toolSpec("change_workflow",
    "Rename a workflow, change its description, or switch it on or off. "
    + "Pausing is enabled=false and is the right answer to \"stop running that\" — deleting throws away its history.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"name\":{\"type\":\"string\",\"description\":\"A new name for the list.\"},"
    + "\"description\":{\"type\":\"string\",\"description\":\"A new one-line description.\"},"
    + "\"enabled\":{\"type\":\"boolean\",\"description\":\"false pauses it, true starts it again and clears its failures.\"}},"
    + "\"required\":[\"workflow\"]}"));

  out.push(toolSpec("run_workflow",
    "Run a workflow at the next opportunity instead of waiting for its time — how somebody checks that "
    + "what was just drafted does what they meant. It does not run inside this conversation and this "
    + "call does not wait for it: the runner picks it up within about a minute and files the result as "
    + "a conversation of its own. The workflow's own schedule is untouched.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"}},"
    + "\"required\":[\"workflow\"]}"));

  out.push(toolSpec("delete_workflow",
    "Remove a workflow and its run history for good. Only when the person asked for it gone — "
    + "\"stop\" and \"pause\" mean change_workflow with enabled=false, which is undoable, and this is not.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"}},"
    + "\"required\":[\"workflow\"]}"));
  return out;
}

function rowsOf(db: Db, owner: string): WorkflowRow[] {
  return JSON.parse<WorkflowRow[]>(listWhere(db, workflowsMapping(),
    "owner = " + db.placeholder, [owner]));
}

function mine(db: Db, owner: string, said: string): WorkflowRow {
  let none = emptyWorkflow();
  if (said == "") {
    return none;
  }
  let document = findById(db, workflowsMapping(), said);
  if (document != "") {
    let row: WorkflowRow = JSON.parse<WorkflowRow>(document);
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
    if (rows[i].name.toLowerCase().trim() == wanted) {
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

function stepOf(graph: WfGraph, said: string): WfNode {
  let wanted = said.toLowerCase().trim();
  let i: int = 0;
  while (i < graph.nodes.length) {
    if (graph.nodes[i].id == said) {
      return graph.nodes[i];
    }
    i = i + 1;
  }
  let found = emptyNode();
  let hits: int = 0;
  i = 0;
  while (i < graph.nodes.length) {
    let name = graph.nodes[i].name.toLowerCase().trim();
    if (name != "" && name == wanted) {
      found = graph.nodes[i];
      hits = hits + 1;
    }
    i = i + 1;
  }
  if (hits == 1) {
    return found;
  }
  return emptyNode();
}

function whenReads(row: WorkflowRow): string {
  if (!row.enabled) {
    return "paused";
  }
  if (row.kind == "manual") {
    return "runs when asked";
  }
  let at = stampMs(row.nextAt);
  if (at <= 0.0) {
    return "nothing scheduled";
  }
  return "next " + civil(row.tz == "" ? "UTC" : row.tz, at as i64);
}

function stepReads(node: WfNode): string {
  if (node.type == "START") {
    return node.schedule == "" ? "start (by hand)" : "start (" + node.schedule + ")";
  }
  if (node.type == "END") {
    return "end — the answer";
  }
  if (node.type == "AGENT") {
    return "agent: " + node.instruction;
  }
  if (node.type == "LLM") {
    return "model: " + node.instruction;
  }
  if (node.type == "WEB_SEARCH") {
    return "web search: " + node.query;
  }
  if (node.type == "KNOWLEDGE") {
    return "documents: " + node.query;
  }
  if (node.type == "HTTP") {
    return node.method + " " + node.url;
  }
  if (node.type == "MCP") {
    return "connector " + node.serverId + ": " + node.tool;
  }
  if (node.type == "CONDITION") {
    return "if the text " + node.test + " \"" + node.needle + "\" — yes/no";
  }
  return node.type;
}

function graphProse(graph: WfGraph): string {
  let out = "";
  let at = startOf(graph);
  let seen: int = 0;
  let branches = false;
  let e: int = 0;
  while (e < graph.edges.length) {
    if (graph.edges[e].when != "") {
      branches = true;
    }
    e = e + 1;
  }
  while (at.id != "" && seen <= graph.nodes.length) {
    seen = seen + 1;
    out = out + "\n  " + `${seen}` + ". " + (at.name == "" ? "" : at.name + " — ") + stepReads(at) + " [" + at.id + "]";
    let toId = "";
    e = 0;
    while (e < graph.edges.length) {
      if (graph.edges[e].from == at.id && graph.edges[e].when == "") {
        toId = graph.edges[e].to;
      }
      e = e + 1;
    }
    if (toId == "") {
      break;
    }
    let next = emptyNode();
    let n: int = 0;
    while (n < graph.nodes.length) {
      if (graph.nodes[n].id == toId) {
        next = graph.nodes[n];
      }
      n = n + 1;
    }
    at = next;
  }
  if (branches) {
    out = out + "\n  ...and it branches:";
    e = 0;
    while (e < graph.edges.length) {
      if (graph.edges[e].when != "") {
        out = out + "\n    " + graph.edges[e].from + " --" + graph.edges[e].when + "--> " + graph.edges[e].to;
      }
      e = e + 1;
    }
  }
  return out;
}

function describe(row: WorkflowRow, parsedSteps: bool): string {
  let line = row.name + " [" + row.id + "]";
  if (row.description != "") {
    line = line + "\n  " + row.description;
  }
  line = line + "\n  " + whenReads(row);
  if (row.tz != "") {
    line = line + " (" + row.tz + ")";
  }
  if (parsedSteps) {
    let parsed = parseGraph(row.graph);
    if (parsed.ok) {
      line = line + graphProse(parsed.graph);
    }
  } else {
    let parsed = parseGraph(row.graph);
    if (parsed.ok) {
      line = line + ", " + `${parsed.graph.nodes.length - 2}` + " steps";
    }
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

export type SaidExtras = {
  options: string,
  cases: string,
  server: string,
  tool: string,
  argsJson: string,
  file: string,
};

export function noExtras(): SaidExtras {
  let none: SaidExtras = { options: "", cases: "", server: "", tool: "", argsJson: "", file: "" };
  return none;
}

function saidNode(kind: string, text: string, title: string, id: string, idx: int, extra: SaidExtras): WfNode {
  let base = emptyNode();
  let made = "";
  if (kind == "agent") {
    made = "AGENT";
  }
  if (kind == "model" || kind == "llm") {
    made = "LLM";
  }
  if (kind == "web_search" || kind == "web") {
    made = "WEB_SEARCH";
  }
  if (kind == "knowledge" || kind == "documents") {
    made = "KNOWLEDGE";
  }
  if (kind == "http" || kind == "fetch") {
    made = "HTTP";
  }
  if (kind == "script") {
    made = "SCRIPT";
  }
  if (kind == "reply") {
    made = "TELEGRAM_REPLY";
  }
  if (kind == "ask") {
    made = "TELEGRAM_ASK";
  }
  if (kind == "connector" || kind == "mcp") {
    made = "MCP";
  }
  if (kind == "switch") {
    made = "SWITCH";
  }
  if (made == "") {
    return base;
  }
  let built: WfNode = {
    id: id, type: made, name: title,
    x: 120.0 + (idx as number) * 240.0, y: 200.0,
    instruction: made == "AGENT" || made == "LLM" || made == "TELEGRAM_REPLY" || made == "TELEGRAM_ASK" ? text : "",
    agentId: "",
    serverId: made == "MCP" ? extra.server : "",
    tool: made == "MCP" ? extra.tool : "",
    args: made == "MCP" ? extra.argsJson : "",
    url: made == "HTTP" ? text : "",
    method: made == "HTTP" ? "GET" : "",
    body: made == "TELEGRAM_REPLY" ? extra.file : "",
    query: made == "WEB_SEARCH" || made == "KNOWLEDGE" ? text : "",
    test: "", needle: "", subject: "",
    schedule: "", source: made == "SCRIPT" ? text : "",
    cases: made == "TELEGRAM_ASK" ? extra.options : made == "SWITCH" ? extra.cases : "",
    secrets: "", secretId: "",
  };
  return built;
}

export function extrasOf(said: string): SaidExtras {
  let held: SaidExtras = {
    options: jsonText(said, "options").trim(),
    cases: jsonText(said, "cases").trim(),
    server: jsonText(said, "server").trim(),
    tool: jsonText(said, "tool").trim(),
    argsJson: jsonRaw(said, "arguments").trim(),
    file: jsonText(said, "file").trim(),
  };
  return held;
}

function startEndNode(kind: string, schedule: string, idx: int): WfNode {
  let base = emptyNode();
  let built: WfNode = {
    id: kind == "START" ? "start" : "end", type: kind,
    name: kind == "START" ? "Start" : "Done",
    x: 120.0 + (idx as number) * 240.0, y: 200.0,
    instruction: "", agentId: "", serverId: "", tool: "", args: "",
    url: "", method: "", body: "", query: "", test: "", needle: "",
    subject: base.subject, source: base.source,
    schedule: kind == "START" ? schedule : "",
  };
  return built;
}

function withText(node: WfNode, text: string, title: string, file: string): WfNode {
  let changed: WfNode = {
    id: node.id, type: node.type,
    name: title == "" ? node.name : title,
    x: node.x, y: node.y,
    instruction: text != "" && (node.type == "AGENT" || node.type == "LLM" || node.type == "TELEGRAM_REPLY" || node.type == "TELEGRAM_ASK") ? text : node.instruction,
    agentId: node.agentId,
    serverId: node.serverId, tool: node.tool, args: node.args,
    url: text != "" && node.type == "HTTP" ? text : node.url,
    method: node.method,
    body: file != "" && node.type == "TELEGRAM_REPLY" ? (file == "none" ? "" : file) : node.body,
    query: text != "" && (node.type == "WEB_SEARCH" || node.type == "KNOWLEDGE") ? text : node.query,
    test: node.test, needle: node.needle, subject: node.subject,
    schedule: node.schedule, source: node.source ?? "",
    cases: node.cases ?? "",
    headers: node.headers ?? "",
    secrets: node.secrets ?? "", secretId: node.secretId ?? "",
  };
  return changed;
}

function withSecrets(node: WfNode, ids: string): WfNode {
  let changed: WfNode = {
    id: node.id, type: node.type, name: node.name, x: node.x, y: node.y,
    instruction: node.instruction, agentId: node.agentId,
    serverId: node.serverId, tool: node.tool, args: node.args,
    url: node.url, method: node.method, body: node.body,
    query: node.query, test: node.test, needle: node.needle,
    subject: node.subject, schedule: node.schedule, source: node.source ?? "",
    cases: node.cases ?? "",
    headers: node.headers ?? "", secrets: ids, secretId: "",
  };
  return changed;
}

function splitSaid(said: string): string[] {
  let out: string[] = [];
  let piece = "";
  let i: int = 0;
  while (i < said.length) {
    let ch = said.charAt(i);
    if (ch == "," || ch == "\n") {
      if (piece.trim() != "") {
        out.push(piece.trim());
      }
      piece = "";
    } else {
      piece = piece + ch;
    }
    i = i + 1;
  }
  if (piece.trim() != "") {
    out.push(piece.trim());
  }
  return out;
}

function withSchedule(node: WfNode, schedule: string): WfNode {
  let changed: WfNode = {
    id: node.id, type: node.type, name: node.name, x: node.x, y: node.y,
    instruction: node.instruction, agentId: node.agentId,
    serverId: node.serverId, tool: node.tool, args: node.args,
    url: node.url, method: node.method, body: node.body,
    query: node.query, test: node.test, needle: node.needle,
    subject: node.subject, schedule: schedule, source: node.source ?? "",
    cases: node.cases ?? "",
    secrets: node.secrets ?? "", secretId: node.secretId ?? "",
  };
  return changed;
}

function edgeOf(from: string, to: string): WfEdge {
  let e: WfEdge = { id: "e" + crypto.randomUUID().slice(0, 8), from: from, to: to, when: "" };
  return e;
}

function branchEdges(node: WfNode, from: string, to: string): WfEdge[] {
  let out: WfEdge[] = [];
  if (node.type != "SWITCH") {
    out.push(edgeOf(from, to));
    return out;
  }
  let all = casesOf(node);
  let i: int = 0;
  while (i < all.length) {
    let e: WfEdge = { id: "e" + crypto.randomUUID().slice(0, 8), from: from, to: to, when: all[i] };
    out.push(e);
    i = i + 1;
  }
  let elseWay: WfEdge = {
    id: "e" + crypto.randomUUID().slice(0, 8),
    from: from,
    to: to,
    when: "else",
  };
  out.push(elseWay);
  return out;
}

type Stored = {
  ok: bool,
  row: WorkflowRow,
  error: string,
};

function storeGraph(db: Db, row: WorkflowRow, graph: WfGraph, zone: string, nowMs: number): Stored {
  let timing = timingOf(graph, zone, nowMs);
  if (!timing.ok) {
    let bad: Stored = { ok: false, row: row, error: timing.error };
    return bad;
  }
  let edited: WorkflowRow = {
    id: row.id, owner: row.owner, agentId: row.agentId,
    modelChoiceId: row.modelChoiceId, name: row.name,
    description: row.description,
    graph: JSON.stringify(graph),
    kind: timing.kind, cronExpr: timing.expr, tz: zone,
    nextAt: timing.kind == "once" ? timing.at : "",
    runningSince: row.runningSince, enabled: row.enabled,
    failures: row.failures, pausedReason: row.pausedReason,
    lastRunAt: row.lastRunAt, lastRunId: row.lastRunId,
    lastStatus: row.lastStatus, lastError: row.lastError,
    runCount: row.runCount,
    publishedGraph: row.publishedGraph ?? "", publishedAt: row.publishedAt ?? "",
    createdAt: row.createdAt, updatedAt: `${nowMs}`,
  };
  let wrong = refuseWorkflow(edited);
  if (wrong != "") {
    let bad: Stored = { ok: false, row: row, error: wrong };
    return bad;
  }
  let secretWrong = new SecretRepository(db).graphFault(graph, row.owner);
  if (secretWrong != "") {
    let bad: Stored = { ok: false, row: row, error: secretWrong };
    return bad;
  }
  let ready = edited;
  if (edited.kind == "every") {
    let first = nextWorkflowFire(edited, nowMs);
    if (!first.ok) {
      let bad: Stored = { ok: false, row: row, error: first.error };
      return bad;
    }
    ready = withWorkflowNextAt(edited, first.at);
  }
  let written = persist(db, workflowsMapping(), JSON.stringify(ready));
  if (!written.ok) {
    let bad: Stored = { ok: false, row: row, error: written.error };
    return bad;
  }
  let good: Stored = { ok: true, row: ready, error: "" };
  return good;
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

export function callWorkflowTool(db: Db, call: WorkflowToolCall): FileToolResult {
  if (call.name != "list_workflows" && call.name != "show_workflow"
    && call.name != "draft_workflow" && call.name != "add_step"
    && call.name != "change_step" && call.name != "remove_step"
    && call.name != "schedule_workflow" && call.name != "change_workflow"
    && call.name != "run_workflow" && call.name != "delete_workflow"
    && call.name != "publish_workflow" && call.name != "connect_steps"
    && call.name != "list_secrets") {
    return not();
  }
  if (!maySchedule(call.owner)) {
    return no("signing in is what makes a workflow theirs to keep — say so, and offer to draft it once they have.");
  }

  if (call.name == "list_workflows") {
    let rows = rowsOf(db, call.owner);
    if (rows.length == 0) {
      return yes("No workflows yet.");
    }
    let out = `${rows.length}` + " workflow" + (rows.length == 1 ? "" : "s") + ":";
    let i: int = 0;
    while (i < rows.length) {
      out = out + "\n\n" + describe(rows[i], false);
      i = i + 1;
    }
    return yes(out);
  }

  if (call.name == "list_secrets") {
    let rows = JSON.parse<SecretRow[]>(new SecretRepository(db).listing(call.owner));
    if (rows.length == 0) {
      return yes("No secrets stored. They are added on the Workflows page (in an http step's settings) or in Settings — never here: a value said in chat is a value in the transcript.");
    }
    let out = `${rows.length}` + " secret" + (rows.length == 1 ? "" : "s") + " — names only, values are write-only:";
    let i: int = 0;
    while (i < rows.length) {
      out = out + "\n- \"" + rows[i].name + "\" fills " + rows[i].header
        + ", sent only to " + rows[i].destination
        + (rows[i].lastUsedAt == "" ? " (never used)" : "");
      i = i + 1;
    }
    return yes(out);
  }

  if (call.name == "draft_workflow") {
    let name = jsonText(call.args, "name").trim();
    if (name == "") {
      return no("give it a name: {\"name\":\"Morning brief\",\"steps\":[...]}");
    }
    let asked = jsonText(call.args, "timezone").trim();
    if (asked != "" && !knownZone(asked)) {
      return no("\"" + asked + "\" is not a timezone this server knows — an IANA name such as Europe/Paris.");
    }
    let running = enabledWorkflowCount(db, call.owner);
    if (running < 0) {
      return no("how many workflows are already running could not be counted, so this one is not being added. Try again in a moment.");
    }
    if (running >= MAX_WORKFLOWS_PER_OWNER) {
      return no("that is " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows already — one has to be paused or deleted first. list_workflows shows them.");
    }
    let saidSteps = jsonList(jsonRaw(call.args, "steps"));
    if (saidSteps.length == 0) {
      return no("say the steps in order: {\"steps\":[{\"kind\":\"web_search\",\"text\":\"...\"},{\"kind\":\"agent\",\"text\":\"...\"}]}");
    }

    let nodes: WfNode[] = [];
    let edges: WfEdge[] = [];
    let said = jsonText(call.args, "schedule").trim();
    let chatty = false;
    let look: int = 0;
    while (look < saidSteps.length) {
      let k = jsonText(saidSteps[look], "kind").trim().toLowerCase();
      if (k == "reply" || k == "ask") {
        chatty = true;
      }
      look = look + 1;
    }
    if (chatty && said != "" && said != "manual" && said != "never") {
      return no("a workflow that talks to a Telegram chat starts when a message arrives — it cannot also run on a schedule. Drop the schedule, or drop the reply/ask steps.");
    }
    if (chatty) {
      let entry = startEndNode("START", "", 0);
      let asTrigger: WfNode = {
        id: entry.id, type: "TELEGRAM", name: "On a message",
        x: entry.x, y: entry.y,
        instruction: "", agentId: "", serverId: "", tool: "", args: "",
        url: "", method: "", body: "", query: "", test: "", needle: "",
        subject: "", schedule: "", source: "",
      };
      nodes.push(asTrigger);
    } else {
      nodes.push(startEndNode("START", said == "manual" || said == "never" ? "" : said, 0));
    }
    let i: int = 0;
    let prevId = "start";
    while (i < saidSteps.length) {
      let kind = jsonText(saidSteps[i], "kind").trim().toLowerCase();
      let text = jsonText(saidSteps[i], "text").trim();
      let title = jsonText(saidSteps[i], "title").trim();
      let id = "s" + `${i + 1}`;
      let built = saidNode(kind, text, title, id, i + 1, extrasOf(saidSteps[i]));
      if (built.id == "") {
        return no("\"" + kind + "\" is not a step kind — " + KINDS_SENTENCE + ".");
      }
      nodes.push(built);
      let prevNode = emptyNode();
      let pn: int = 0;
      while (pn < nodes.length) { if (nodes[pn].id == prevId) {
        prevNode = nodes[pn];
      } pn = pn + 1; }
      let ways = branchEdges(prevNode, prevId, id);
      let w: int = 0;
      while (w < ways.length) {
        edges.push(ways[w]);
        w = w + 1;
      }
      prevId = id;
      i = i + 1;
    }
    nodes.push(startEndNode("END", "", saidSteps.length + 1));
    edges.push(edgeOf(prevId, "end"));
    let view: WfView = { x: 0.0, y: 0.0, zoom: 0.6 };
    let graph: WfGraph = { nodes: nodes, edges: edges, view: view };

    let zone = zoneFor(db, call.owner, asked);
    let now = `${call.nowMs}`;
    let row: WorkflowRow = {
      id: crypto.randomUUID(), owner: call.owner, agentId: call.agentId,
      modelChoiceId: "", name: name,
      description: jsonText(call.args, "description").trim(),
      graph: "", kind: "manual", cronExpr: "", tz: zone, nextAt: "",
      runningSince: "", enabled: true, failures: 0, pausedReason: "",
      lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
      runCount: 0, publishedGraph: "", publishedAt: "", createdAt: now, updatedAt: now,
    };
    let stored = storeGraph(db, row, graph, zone, call.nowMs);
    if (!stored.ok) {
      return no(stored.error);
    }
    return yes("Drafted.\n\n" + describe(stored.row, true)
      + "\n\nIt is on the Workflows page to rearrange by hand. run_workflow tries it out"
      + (stored.row.kind == "manual" ? "." : "; each firing files a conversation of its own.")
      + (asked == "" && stored.row.kind != "manual" ? "\nTimes are read in " + zone + " — say so, in case that is not where they are." : ""));
  }

  let row = mine(db, call.owner, jsonText(call.args, "workflow").trim());
  if (row.id == "") {
    return no("no workflow of theirs by that id or name — call list_workflows and use an id from it.");
  }

  if (call.name == "show_workflow") {
    return yes(describe(row, true));
  }

  if (call.name == "publish_workflow") {
    let sql = "UPDATE workflows SET published_graph = graph, published_at = " + db.placeholder
      + ", updated_at = " + placeholderAt(db, 2)
      + " WHERE id = " + placeholderAt(db, 3);
    let now = `${call.nowMs}`;
    if (!db.query(sql, [now, now, row.id])) {
      return no("nothing was published — \"" + row.name + "\" still runs the version it ran before.");
    }
    // Read back for the description only. findById answers "" for a row that
    // has gone as well as for a read that did not run, and JSON.parse of ""
    // throws out of the whole turn — so the publish, which has already
    // happened, would be reported as nothing at all.
    let after = findById(db, workflowsMapping(), row.id);
    if (after == "") {
      return yes("Published — messages and the clock now run what you see.");
    }
    let fresh: WorkflowRow = JSON.parse<WorkflowRow>(after);
    return yes("Published — messages and the clock now run what you see. " + describe(fresh, false));
  }

  if (call.name == "run_workflow") {
    if (!row.enabled) {
      let running = enabledWorkflowCount(db, call.owner);
      if (running < 0) {
        return no("how many workflows are already running could not be counted, so this one is not being resumed. Try again in a moment.");
      }
      if (running >= MAX_WORKFLOWS_PER_OWNER) {
        return no("that is " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows already — one has to be paused or deleted before this one can run. list_workflows shows them.");
      }
    }
    let now = `${call.nowMs}`;
    let written = executeWith(db,
      "UPDATE workflows SET next_at = " + db.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(db, 2)
      + " WHERE id = " + placeholderAt(db, 3),
      [now, now, row.id]);
    if (!written.ok) {
      return no(written.error);
    }
    return yes("\"" + row.name + "\" will run within about a minute, in a conversation of its own — it does not answer here. "
      + "Its own schedule is unchanged.");
  }

  if (call.name == "delete_workflow") {
    let cleared = executeWith(db, "DELETE FROM workflow_runs WHERE workflow_id = " + db.placeholder, [row.id]);
    if (!cleared.ok) {
      return no(cleared.error);
    }
    let gone = deleteById(db, workflowsMapping(), row.id);
    if (!gone.ok) {
      return no(gone.error);
    }
    return yes("Deleted \"" + row.name + "\" and its history. It will not run again.");
  }

  if (call.name == "change_workflow") {
    let name = jsonText(call.args, "name").trim();
    let description = jsonText(call.args, "description").trim();
    let on = jsonFlag(call.args, "enabled", row.enabled);
    if (on && !row.enabled) {
      let running = enabledWorkflowCount(db, call.owner);
      if (running < 0) {
        return no("how many workflows are already running could not be counted, so this one is not being resumed. Try again in a moment.");
      }
      if (running >= MAX_WORKFLOWS_PER_OWNER) {
        return no("that is " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows already — one has to be paused or deleted before another can run. list_workflows shows them.");
      }
    }
    let edited: WorkflowRow = {
      id: row.id, owner: row.owner, agentId: row.agentId,
      modelChoiceId: row.modelChoiceId,
      name: name == "" ? row.name : name,
      description: description == "" ? row.description : description,
      graph: row.graph, kind: row.kind, cronExpr: row.cronExpr, tz: row.tz,
      nextAt: row.nextAt, runningSince: row.runningSince,
      enabled: on,
      failures: on && !row.enabled ? 0 : row.failures,
      pausedReason: on ? "" : row.pausedReason,
      lastRunAt: row.lastRunAt, lastRunId: row.lastRunId,
      lastStatus: row.lastStatus, lastError: row.lastError,
      runCount: row.runCount,
      publishedGraph: row.publishedGraph ?? "", publishedAt: row.publishedAt ?? "",
      createdAt: row.createdAt, updatedAt: `${call.nowMs}`,
    };
    let wrong = refuseWorkflow(edited);
    if (wrong != "") {
      return no(wrong);
    }
    let stored = edited;
    if (on && !row.enabled && edited.kind == "every") {
      let ahead = nextWorkflowFire(edited, call.nowMs);
      if (ahead.ok) {
        stored = withWorkflowNextAt(edited, ahead.at);
      }
    }
    let written = persist(db, workflowsMapping(), JSON.stringify(stored));
    if (!written.ok) {
      return no(written.error);
    }
    return yes("Changed.\n\n" + describe(stored, false));
  }

  if (call.name == "schedule_workflow") {
    let asked = jsonText(call.args, "timezone").trim();
    if (asked != "" && !knownZone(asked)) {
      return no("\"" + asked + "\" is not a timezone this server knows — an IANA name such as Europe/Paris.");
    }
    let zone = asked == "" ? (row.tz == "" ? zoneFor(db, call.owner, "") : row.tz) : asked;
    let said = jsonText(call.args, "schedule").trim();
    if (said == "manual" || said == "never" || said == "by hand") {
      said = "";
    }
    let parsed = parseGraph(row.graph);
    if (!parsed.ok) {
      return no(parsed.error);
    }
    let nodes: WfNode[] = [];
    let i: int = 0;
    while (i < parsed.graph.nodes.length) {
      let n = parsed.graph.nodes[i];
      nodes.push(n.type == "START" ? withSchedule(n, said) : n);
      i = i + 1;
    }
    let graph: WfGraph = { nodes: nodes, edges: parsed.graph.edges, view: parsed.graph.view };
    let stored = storeGraph(db, row, graph, zone, call.nowMs);
    if (!stored.ok) {
      return no(stored.error);
    }
    return yes((said == "" ? "It now runs only when asked." : "Scheduled.") + "\n\n" + describe(stored.row, false));
  }

  let parsed = parseGraph(row.graph);
  if (!parsed.ok) {
    return no(parsed.error);
  }
  let graph = parsed.graph;

  if (call.name == "add_step") {
    let kind = jsonText(call.args, "kind").trim().toLowerCase();
    let text = jsonText(call.args, "text").trim();
    if (text == "" && kind != "switch" && kind != "connector" && kind != "mcp") {
      return no("say what the step does: {\"kind\":\"agent\",\"text\":\"...\"}");
    }
    let saidAfter = jsonText(call.args, "after").trim();
    let fromId = "";
    if (saidAfter != "") {
      let anchor = stepOf(graph, saidAfter);
      if (anchor.id == "") {
        return no("no step by that id or name — show_workflow lists them.");
      }
      if (anchor.type == "END") {
        return no("nothing runs after the end — name the step to add after, or leave it out.");
      }
      fromId = anchor.id;
    } else {
      let e: int = 0;
      while (e < graph.edges.length) {
        let toNode = stepOf(graph, graph.edges[e].to);
        if (toNode.type == "END" && graph.edges[e].when == "") {
          fromId = graph.edges[e].from;
        }
        e = e + 1;
      }
      if (fromId == "") {
        return no("this workflow's end is reached by a branch — open it on the Workflows page and add the step there.");
      }
    }
    let oldTo = "";
    let branchy = false;
    let e2: int = 0;
    while (e2 < graph.edges.length) {
      if (graph.edges[e2].from == fromId) {
        if (graph.edges[e2].when != "") {
          branchy = true;
        }
        else {
          oldTo = graph.edges[e2].to;
        }
      }
      e2 = e2 + 1;
    }
    if (branchy) {
      return no("that step branches — open the workflow on the Workflows page and add the step where it belongs.");
    }
    let id = "s" + crypto.randomUUID().slice(0, 8);
    let anchorNode = stepOf(graph, fromId);
    let built = saidNode(kind, text, jsonText(call.args, "title").trim(), id, 0, extrasOf(call.args));
    if (built.id == "") {
      return no("\"" + kind + "\" is not a step kind — " + KINDS_SENTENCE + ".");
    }
    let placed: WfNode = {
      id: built.id, type: built.type, name: built.name,
      x: anchorNode.x + 120.0, y: anchorNode.y + 140.0,
      instruction: built.instruction, agentId: built.agentId,
      serverId: built.serverId, tool: built.tool, args: built.args,
      url: built.url, method: built.method, body: built.body,
      query: built.query, test: built.test, needle: built.needle,
      subject: built.subject, schedule: built.schedule, source: built.source ?? "",
      cases: built.cases ?? "",
      secrets: built.secrets ?? "", secretId: built.secretId ?? "",
    };
    let nodes: WfNode[] = [];
    let n: int = 0;
    while (n < graph.nodes.length) {
      nodes.push(graph.nodes[n]);
      n = n + 1;
    }
    nodes.push(placed);
    let edges: WfEdge[] = [];
    let e3: int = 0;
    while (e3 < graph.edges.length) {
      let edge = graph.edges[e3];
      if (edge.from == fromId && edge.when == "" && edge.to == oldTo) {
        edges.push(edgeOf(fromId, id));
        if (oldTo != "") {
          let fan = branchEdges(placed, id, oldTo);
          let b: int = 0;
          while (b < fan.length) {
            edges.push(fan[b]);
            b = b + 1;
          }
        }
      } else {
        edges.push(edge);
      }
      e3 = e3 + 1;
    }
    if (oldTo == "") {
      edges.push(edgeOf(fromId, id));
    }
    let grown: WfGraph = { nodes: nodes, edges: edges, view: graph.view };
    let stored = storeGraph(db, row, grown, row.tz, call.nowMs);
    if (!stored.ok) {
      return no(stored.error);
    }
    return yes("Added.\n\n" + describe(stored.row, true));
  }

  let anchorSaid = call.name == "connect_steps" ? jsonText(call.args, "from").trim() : jsonText(call.args, "step").trim();
  let node = stepOf(graph, anchorSaid);
  if (node.id == "") {
    return no("no step by that id or name — show_workflow lists them.");
  }

  if (call.name == "connect_steps") {
    let toSaid = jsonText(call.args, "to").trim();
    let target = stepOf(graph, toSaid);
    if (target.id == "") {
      return no("no step called \"" + toSaid + "\" — show_workflow lists them.");
    }
    let branch = jsonText(call.args, "branch").trim();
    let edges2: WfEdge[] = [];
    let moved = false;
    let ec: int = 0;
    while (ec < graph.edges.length) {
      let edge = graph.edges[ec];
      if (edge.from == node.id && edge.when == branch) {
        let re: WfEdge = { id: edge.id, from: edge.from, to: target.id, when: edge.when };
        edges2.push(re);
        moved = true;
      } else {
        edges2.push(edge);
      }
      ec = ec + 1;
    }
    if (!moved) {
      let fresh2: WfEdge = {
        id: "e" + crypto.randomUUID().slice(0, 8),
        from: node.id,
        to: target.id,
        when: branch,
      };
      edges2.push(fresh2);
    }
    let rewired: WfGraph = { nodes: graph.nodes, edges: edges2, view: graph.view };
    let stored = storeGraph(db, row, rewired, row.tz, call.nowMs);
    if (!stored.ok) {
      return no(stored.error);
    }
    return yes("Connected.\n\n" + describe(stored.row, true));
  }

  if (call.name == "change_step") {
    let text = jsonText(call.args, "text").trim();
    let title = jsonText(call.args, "title").trim();
    let file = jsonText(call.args, "file").trim();
    let secretSaid = jsonText(call.args, "secret").trim();
    if (text == "" && title == "" && file == "" && secretSaid == "") {
      return no("say what changes: text, a title, a file, a secret, or any of them.");
    }
    if (text != "" && (node.type == "START" || node.type == "END" || node.type == "CONDITION" || node.type == "MCP")) {
      return no("a " + node.type + " step is edited on the Workflows page — text here changes agent, model, web_search, knowledge, reply and ask steps.");
    }
    if (file != "" && node.type != "TELEGRAM_REPLY") {
      return no("only a reply step sends a file — the file rides a reply, with the text as its caption.");
    }
    let ids = "";
    let s: int = 0;
    let already = secretIds(node);
    while (s < already.length) {
      ids = ids == "" ? already[s] : ids + "," + already[s];
      s = s + 1;
    }
    if (secretSaid != "") {
      if (secretSaid == "none") {
        ids = "";
      } else {
        let wanted = splitSaid(secretSaid);
        ids = "";
        let w: int = 0;
        while (w < wanted.length) {
          let held = new SecretRepository(db).byName(wanted[w], call.owner);
          if (held.id == "") {
            return no("there is no secret called \"" + wanted[w] + "\" — list_secrets says which exist; new ones are added in the step's settings or in Settings, never in chat.");
          }
          ids = ids == "" ? held.id : ids + "," + held.id;
          w = w + 1;
        }
      }
    }
    let nodes: WfNode[] = [];
    let n: int = 0;
    while (n < graph.nodes.length) {
      nodes.push(graph.nodes[n].id == node.id
        ? withSecrets(withText(graph.nodes[n], text, title, file), ids)
        : graph.nodes[n]);
      n = n + 1;
    }
    let changed: WfGraph = { nodes: nodes, edges: graph.edges, view: graph.view };
    let stored = storeGraph(db, row, changed, row.tz, call.nowMs);
    if (!stored.ok) {
      return no(stored.error);
    }
    return yes("Changed.\n\n" + describe(stored.row, true));
  }

  if (node.type == "START" || node.type == "END") {
    return no("every workflow keeps its start and end — remove the steps between them.");
  }
  let inFrom = "";
  let outTo = "";
  let tangled = false;
  let e4: int = 0;
  while (e4 < graph.edges.length) {
    let edge = graph.edges[e4];
    if (edge.to == node.id) {
      if (inFrom != "" || edge.when != "") {
        tangled = true;
      }
      inFrom = edge.from;
    }
    if (edge.from == node.id) {
      if (outTo != "" || edge.when != "") {
        tangled = true;
      }
      outTo = edge.to;
    }
    e4 = e4 + 1;
  }
  if (tangled) {
    return no("that step sits on a branch — open the workflow on the Workflows page and remove it there.");
  }
  let nodes: WfNode[] = [];
  let n2: int = 0;
  while (n2 < graph.nodes.length) {
    if (graph.nodes[n2].id != node.id) {
      nodes.push(graph.nodes[n2]);
    }
    n2 = n2 + 1;
  }
  let edges: WfEdge[] = [];
  let e5: int = 0;
  while (e5 < graph.edges.length) {
    let edge = graph.edges[e5];
    if (edge.from != node.id && edge.to != node.id) {
      edges.push(edge);
    }
    e5 = e5 + 1;
  }
  if (inFrom != "" && outTo != "") {
    edges.push(edgeOf(inFrom, outTo));
  }
  let shrunk: WfGraph = { nodes: nodes, edges: edges, view: graph.view };
  let stored = storeGraph(db, row, shrunk, row.tz, call.nowMs);
  if (!stored.ok) {
    return no(stored.error);
  }
  return yes("Removed.\n\n" + describe(stored.row, true));
}
