// Workflows, as tools an agent can call.
//
// The Workflows page is a canvas: you drag steps, connect them, press Run.
// This is the other door onto the same rows — "every morning, search the web
// for what changed about Lumen and have the assistant brief me" said in a
// conversation, and a workflow exists, drawn and scheduled, that the person
// can then open and rearrange by hand.
//
// Two doors, one set of rules, exactly as task-tools.ts holds them: every
// refusal here is `packages/workflow`'s or `workflow-store.ts`'s own, called
// from this side rather than reworded. What this module owns is prose — how
// a graph is described to something that reads text — and the chain builder,
// because a model should say "search, then summarise" and never place a
// pixel.
//
// WHAT IT MAY NOT DO IS AS IMPORTANT AS WHAT IT DOES:
//
//   Nothing here fires anything. `run_workflow` moves `next_at` and stops,
//   exactly as run_task_now does, so there stays one place a workflow can be
//   claimed and recorded (scheduler.ts).
//
//   Nothing here crosses an owner. Somebody else's workflow is absent, not
//   forbidden.
//
//   Nothing here draws. The tools build and edit CHAINS — the shape a
//   sentence can describe. A graph that branches is the canvas's business,
//   and a tool asked to splice around a branch says to open the page rather
//   than guessing which arm was meant.

import { Db } from "../plume/driver.ts";
import { deleteById, executeWith, findById, listWhere, persist, placeholderAt } from "../plume/plume.ts";
import { ToolSpec, toolSpec } from "./provider.ts";
import { FileToolResult } from "./workspace.ts";
import { jsonFlag, jsonList, jsonRaw, jsonText } from "./scan.ts";
import { maySchedule } from "./task-tools.ts";
import { civil, knownZone } from "./../cron/cron.ts";
import { WfEdge, WfGraph, WfNode, WfView, emptyNode, refuse as refuseGraph, startOf } from "../workflow/workflow.ts";
import { MAX_WORKFLOWS_PER_OWNER, WorkflowRow, WorkflowRunRow, emptyWorkflow, enabledWorkflowCount, nextWorkflowFire, parseGraph, refuseWorkflow, timingOf, withWorkflowNextAt, workflowRunsMapping, workflowsMapping } from "./workflow-store.ts";
import { stampMs } from "./tasks.ts";

// The step kinds a sentence can ask for, in the words a model would reach
// for. The canvas vocabulary is wider (CONDITION branches are drawn, not
// said); this list is what draft_workflow and add_step accept.
const SAID_KINDS = "\\\"agent\\\" (a full agent turn with its tools), \\\"model\\\" (one model call, no tools), "
  + "\\\"web_search\\\" (the deployment's web index), \\\"knowledge\\\" (the agent's documents), "
  + "\\\"http\\\" (fetch a url)";

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

// The tools, described for a model. Every quote inside a schema is \\\" — an
// escaped quote in the JSON the string becomes — because a schema reaches the
// provider verbatim and one bare quote ends the request (task-tools.ts
// records the DeepSeek 400 that taught this).
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
    + "\"title\":{\"type\":\"string\",\"description\":\"A short label for the canvas, such as \\\"Search the news\\\".\"}},"
    + "\"required\":[\"kind\",\"text\"]}},"
    + "\"schedule\":{\"type\":\"string\",\"description\":\"" + schedule + "\"},"
    + "\"timezone\":{\"type\":\"string\",\"description\":\"" + zone + "\"}},"
    + "\"required\":[\"name\",\"steps\"]}"));

  out.push(toolSpec("add_step",
    "Add one step to a workflow's chain. It is spliced in after the step named — or just before the "
    + "end when none is named. A workflow that branches at that point has to be rearranged on the "
    + "Workflows page instead.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"kind\":{\"type\":\"string\",\"description\":\"One of " + SAID_KINDS + ".\"},"
    + "\"text\":{\"type\":\"string\",\"description\":\"What the step does. {{prev}} is the previous step's output.\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"A short label for the canvas.\"},"
    + "\"after\":{\"type\":\"string\",\"description\":\"" + step + " Leave out to add before the end.\"}},"
    + "\"required\":[\"workflow\",\"kind\",\"text\"]}"));

  out.push(toolSpec("change_step",
    "Change what one step does or what it is called. Only what is sent changes.",
    "{\"type\":\"object\",\"properties\":{"
    + "\"workflow\":{\"type\":\"string\",\"description\":\"" + which + "\"},"
    + "\"step\":{\"type\":\"string\",\"description\":\"" + step + "\"},"
    + "\"text\":{\"type\":\"string\",\"description\":\"The new instruction, query or url — whole, for the kind of step it is.\"},"
    + "\"title\":{\"type\":\"string\",\"description\":\"A new label for the canvas.\"}},"
    + "\"required\":[\"workflow\",\"step\"]}"));

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

/** The workflow this call is about, or an empty row — by id, then by unique
 *  name, ambiguity refused, exactly as task-tools resolves a task. */
function mine(db: Db, owner: string, said: string): WorkflowRow {
  let none = emptyWorkflow();
  if (said == "") { return none; }
  let document = findById(db, workflowsMapping(), said);
  if (document != "") {
    let row: WorkflowRow = JSON.parse<WorkflowRow>(document);
    if (row.owner == owner) { return row; }
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
  if (hits == 1) { return found; }
  return none;
}

/** A step of this graph, by id then by unique name. */
function stepOf(graph: WfGraph, said: string): WfNode {
  let wanted = said.toLowerCase().trim();
  let i: int = 0;
  while (i < graph.nodes.length) {
    if (graph.nodes[i].id == said) { return graph.nodes[i]; }
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
  if (hits == 1) { return found; }
  return emptyNode();
}

function whenReads(row: WorkflowRow): string {
  if (!row.enabled) { return "paused"; }
  if (row.kind == "manual") { return "runs when asked"; }
  let at = stampMs(row.nextAt);
  if (at <= 0.0) { return "nothing scheduled"; }
  return "next " + civil(row.tz == "" ? "UTC" : row.tz, at as i64);
}

/** What one step does, in a phrase. */
function stepReads(node: WfNode): string {
  if (node.type == "START") { return node.schedule == "" ? "start (by hand)" : "start (" + node.schedule + ")"; }
  if (node.type == "END") { return "end — the answer"; }
  if (node.type == "AGENT") { return "agent: " + node.instruction; }
  if (node.type == "LLM") { return "model: " + node.instruction; }
  if (node.type == "WEB_SEARCH") { return "web search: " + node.query; }
  if (node.type == "KNOWLEDGE") { return "documents: " + node.query; }
  if (node.type == "HTTP") { return node.method + " " + node.url; }
  if (node.type == "MCP") { return "connector " + node.serverId + ": " + node.tool; }
  if (node.type == "CONDITION") { return "if the text " + node.test + " \"" + node.needle + "\" — yes/no"; }
  return node.type;
}

/** The chain in walking order, as prose. A graph the tools built is a chain;
 *  one the canvas rearranged may branch, and then the edges are named too. */
function graphProse(graph: WfGraph): string {
  let out = "";
  let at = startOf(graph);
  let seen: int = 0;
  let branches = false;
  let e: int = 0;
  while (e < graph.edges.length) {
    if (graph.edges[e].when != "") { branches = true; }
    e = e + 1;
  }
  while (at.id != "" && seen <= graph.nodes.length) {
    seen = seen + 1;
    out = out + "\n  " + `${seen}` + ". " + (at.name == "" ? "" : at.name + " — ") + stepReads(at) + " [" + at.id + "]";
    let toId = "";
    e = 0;
    while (e < graph.edges.length) {
      if (graph.edges[e].from == at.id && graph.edges[e].when == "") { toId = graph.edges[e].to; }
      e = e + 1;
    }
    if (toId == "") { break; }
    let next = emptyNode();
    let n: int = 0;
    while (n < graph.nodes.length) {
      if (graph.nodes[n].id == toId) { next = graph.nodes[n]; }
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
  if (row.description != "") { line = line + "\n  " + row.description; }
  line = line + "\n  " + whenReads(row);
  if (row.tz != "") { line = line + " (" + row.tz + ")"; }
  if (parsedSteps) {
    let parsed = parseGraph(row.graph);
    if (parsed.ok) { line = line + graphProse(parsed.graph); }
  } else {
    let parsed = parseGraph(row.graph);
    if (parsed.ok) { line = line + ", " + `${parsed.graph.nodes.length - 2}` + " steps"; }
  }
  if (row.runCount > 0) {
    line = line + "\n  ran " + `${row.runCount}` + " time" + (row.runCount == 1 ? "" : "s");
    if (row.lastStatus == "failed") { line = line + ", last one failed: " + row.lastError; }
  }
  if (!row.enabled && row.pausedReason != "") { line = line + "\n  paused: " + row.pausedReason; }
  return line;
}

// ---------------------------------------------------------------------------
// Building and splicing chains
// ---------------------------------------------------------------------------

/** One said step as a node. `idx` places it; ids are short and stable so a
 *  model can quote them back. */
function saidNode(kind: string, text: string, title: string, id: string, idx: int): WfNode {
  let base = emptyNode();
  let made = "";
  if (kind == "agent") { made = "AGENT"; }
  if (kind == "model" || kind == "llm") { made = "LLM"; }
  if (kind == "web_search" || kind == "web") { made = "WEB_SEARCH"; }
  if (kind == "knowledge" || kind == "documents") { made = "KNOWLEDGE"; }
  if (kind == "http" || kind == "fetch") { made = "HTTP"; }
  if (made == "") { return base; }
  let built: WfNode = {
    id: id, type: made, name: title,
    x: 120.0 + (idx as number) * 240.0, y: 200.0,
    instruction: made == "AGENT" || made == "LLM" ? text : "",
    agentId: "",
    serverId: "", tool: "", args: "",
    url: made == "HTTP" ? text : "",
    method: made == "HTTP" ? "GET" : "",
    body: "",
    query: made == "WEB_SEARCH" || made == "KNOWLEDGE" ? text : "",
    test: "", needle: "", subject: "",
    schedule: "",
  };
  return built;
}

function startEndNode(kind: string, schedule: string, idx: int): WfNode {
  let base = emptyNode();
  let built: WfNode = {
    id: kind == "START" ? "start" : "end", type: kind,
    name: kind == "START" ? "Start" : "Done",
    x: 120.0 + (idx as number) * 240.0, y: 200.0,
    instruction: "", agentId: "", serverId: "", tool: "", args: "",
    url: "", method: "", body: "", query: "", test: "", needle: "",
    subject: base.subject,
    schedule: kind == "START" ? schedule : "",
  };
  return built;
}

/** The text a step carries, changed for its kind — the one field a sentence
 *  edits. */
function withText(node: WfNode, text: string, title: string): WfNode {
  let changed: WfNode = {
    id: node.id, type: node.type,
    name: title == "" ? node.name : title,
    x: node.x, y: node.y,
    instruction: text != "" && (node.type == "AGENT" || node.type == "LLM") ? text : node.instruction,
    agentId: node.agentId,
    serverId: node.serverId, tool: node.tool, args: node.args,
    url: text != "" && node.type == "HTTP" ? text : node.url,
    method: node.method, body: node.body,
    query: text != "" && (node.type == "WEB_SEARCH" || node.type == "KNOWLEDGE") ? text : node.query,
    test: node.test, needle: node.needle, subject: node.subject,
    schedule: node.schedule,
  };
  return changed;
}

function withSchedule(node: WfNode, schedule: string): WfNode {
  let changed: WfNode = {
    id: node.id, type: node.type, name: node.name, x: node.x, y: node.y,
    instruction: node.instruction, agentId: node.agentId,
    serverId: node.serverId, tool: node.tool, args: node.args,
    url: node.url, method: node.method, body: node.body,
    query: node.query, test: node.test, needle: node.needle,
    subject: node.subject, schedule: schedule,
  };
  return changed;
}

function edgeOf(from: string, to: string): WfEdge {
  let e: WfEdge = { id: "e-" + from + "-" + to, from: from, to: to, when: "" };
  return e;
}

/** The row, rebuilt around a new graph and re-timed from its START — the one
 *  place a graph write happens, so refusal and recompilation cannot be
 *  skipped by one door and honoured by another. */
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
    runCount: row.runCount, createdAt: row.createdAt, updatedAt: `${nowMs}`,
  };
  let wrong = refuseWorkflow(edited);
  if (wrong != "") {
    let bad: Stored = { ok: false, row: row, error: wrong };
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

/** The zone to schedule in: asked, then this person's other workflows', then
 *  the deployment's, then UTC — the task-tools ladder. */
function zoneFor(db: Db, owner: string, asked: string): string {
  if (asked != "") { return asked; }
  let rows = rowsOf(db, owner);
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].tz != "") { return rows[i].tz; }
    i = i + 1;
  }
  let set = (process.env("AGENTS_TZ") ?? "").trim();
  if (set != "") { return set; }
  return "UTC";
}

// Dispatch one call. `handled` false means the name is not ours.
export function callWorkflowTool(db: Db, call: WorkflowToolCall): FileToolResult {
  if (call.name != "list_workflows" && call.name != "show_workflow"
    && call.name != "draft_workflow" && call.name != "add_step"
    && call.name != "change_step" && call.name != "remove_step"
    && call.name != "schedule_workflow" && call.name != "change_workflow"
    && call.name != "run_workflow" && call.name != "delete_workflow") {
    return not();
  }
  if (!maySchedule(call.owner)) {
    return no("signing in is what makes a workflow theirs to keep — say so, and offer to draft it once they have.");
  }

  if (call.name == "list_workflows") {
    let rows = rowsOf(db, call.owner);
    if (rows.length == 0) { return yes("No workflows yet."); }
    let out = `${rows.length}` + " workflow" + (rows.length == 1 ? "" : "s") + ":";
    let i: int = 0;
    while (i < rows.length) {
      out = out + "\n\n" + describe(rows[i], false);
      i = i + 1;
    }
    return yes(out);
  }

  if (call.name == "draft_workflow") {
    let name = jsonText(call.args, "name").trim();
    if (name == "") { return no("give it a name: {\"name\":\"Morning brief\",\"steps\":[...]}"); }
    let asked = jsonText(call.args, "timezone").trim();
    if (asked != "" && !knownZone(asked)) {
      return no("\"" + asked + "\" is not a timezone this server knows — an IANA name such as Europe/Paris.");
    }
    if (enabledWorkflowCount(db, call.owner) >= MAX_WORKFLOWS_PER_OWNER) {
      return no("that is " + `${MAX_WORKFLOWS_PER_OWNER}` + " workflows already — one has to be paused or deleted first. list_workflows shows them.");
    }
    let saidSteps = jsonList(jsonRaw(call.args, "steps"));
    if (saidSteps.length == 0) { return no("say the steps in order: {\"steps\":[{\"kind\":\"web_search\",\"text\":\"...\"},{\"kind\":\"agent\",\"text\":\"...\"}]}"); }

    let nodes: WfNode[] = [];
    let edges: WfEdge[] = [];
    let said = jsonText(call.args, "schedule").trim();
    nodes.push(startEndNode("START", said == "manual" || said == "never" ? "" : said, 0));
    let i: int = 0;
    let prevId = "start";
    while (i < saidSteps.length) {
      let kind = jsonText(saidSteps[i], "kind").trim().toLowerCase();
      let text = jsonText(saidSteps[i], "text").trim();
      let title = jsonText(saidSteps[i], "title").trim();
      let id = "s" + `${i + 1}`;
      let built = saidNode(kind, text, title, id, i + 1);
      if (built.id == "") {
        return no("\"" + kind + "\" is not a step kind — the kinds are agent, model, web_search, knowledge and http.");
      }
      nodes.push(built);
      edges.push(edgeOf(prevId, id));
      prevId = id;
      i = i + 1;
    }
    nodes.push(startEndNode("END", "", saidSteps.length + 1));
    edges.push(edgeOf(prevId, "end"));
    // 60%: a five-step chain fits a laptop screen at this zoom, and the person
    // can always lean in. The console opens drawings at the same figure.
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
      runCount: 0, createdAt: now, updatedAt: now,
    };
    let stored = storeGraph(db, row, graph, zone, call.nowMs);
    if (!stored.ok) { return no(stored.error); }
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

  if (call.name == "run_workflow") {
    let now = `${call.nowMs}`;
    executeWith(db,
      "UPDATE workflows SET next_at = " + db.placeholder
      + ", running_since = '', enabled = true, updated_at = " + placeholderAt(db, 2)
      + " WHERE id = " + placeholderAt(db, 3),
      [now, now, row.id]);
    return yes("\"" + row.name + "\" will run within about a minute, in a conversation of its own — it does not answer here. "
      + "Its own schedule is unchanged.");
  }

  if (call.name == "delete_workflow") {
    executeWith(db, "DELETE FROM workflow_runs WHERE workflow_id = " + db.placeholder, [row.id]);
    let gone = deleteById(db, workflowsMapping(), row.id);
    if (!gone.ok) { return no(gone.error); }
    return yes("Deleted \"" + row.name + "\" and its history. It will not run again.");
  }

  if (call.name == "change_workflow") {
    let name = jsonText(call.args, "name").trim();
    let description = jsonText(call.args, "description").trim();
    let on = jsonFlag(call.args, "enabled", row.enabled);
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
      runCount: row.runCount, createdAt: row.createdAt, updatedAt: `${call.nowMs}`,
    };
    let wrong = refuseWorkflow(edited);
    if (wrong != "") { return no(wrong); }
    // A paused schedule that comes back on needs a firing to come back to.
    let stored = edited;
    if (on && !row.enabled && edited.kind == "every") {
      let ahead = nextWorkflowFire(edited, call.nowMs);
      if (ahead.ok) { stored = withWorkflowNextAt(edited, ahead.at); }
    }
    let written = persist(db, workflowsMapping(), JSON.stringify(stored));
    if (!written.ok) { return no(written.error); }
    return yes("Changed.\n\n" + describe(stored, false));
  }

  if (call.name == "schedule_workflow") {
    let asked = jsonText(call.args, "timezone").trim();
    if (asked != "" && !knownZone(asked)) {
      return no("\"" + asked + "\" is not a timezone this server knows — an IANA name such as Europe/Paris.");
    }
    let zone = asked == "" ? (row.tz == "" ? zoneFor(db, call.owner, "") : row.tz) : asked;
    let said = jsonText(call.args, "schedule").trim();
    if (said == "manual" || said == "never" || said == "by hand") { said = ""; }
    let parsed = parseGraph(row.graph);
    if (!parsed.ok) { return no(parsed.error); }
    let nodes: WfNode[] = [];
    let i: int = 0;
    while (i < parsed.graph.nodes.length) {
      let n = parsed.graph.nodes[i];
      nodes.push(n.type == "START" ? withSchedule(n, said) : n);
      i = i + 1;
    }
    let graph: WfGraph = { nodes: nodes, edges: parsed.graph.edges, view: parsed.graph.view };
    let stored = storeGraph(db, row, graph, zone, call.nowMs);
    if (!stored.ok) { return no(stored.error); }
    return yes((said == "" ? "It now runs only when asked." : "Scheduled.") + "\n\n" + describe(stored.row, false));
  }

  // The three chain edits share the parse.
  let parsed = parseGraph(row.graph);
  if (!parsed.ok) { return no(parsed.error); }
  let graph = parsed.graph;

  if (call.name == "add_step") {
    let kind = jsonText(call.args, "kind").trim().toLowerCase();
    let text = jsonText(call.args, "text").trim();
    if (text == "") { return no("say what the step does: {\"kind\":\"agent\",\"text\":\"...\"}"); }
    let saidAfter = jsonText(call.args, "after").trim();
    // Where the splice happens: after the named step, or on the edge into END.
    let fromId = "";
    if (saidAfter != "") {
      let anchor = stepOf(graph, saidAfter);
      if (anchor.id == "") { return no("no step by that id or name — show_workflow lists them."); }
      if (anchor.type == "END") { return no("nothing runs after the end — name the step to add after, or leave it out."); }
      fromId = anchor.id;
    } else {
      let e: int = 0;
      while (e < graph.edges.length) {
        let toNode = stepOf(graph, graph.edges[e].to);
        if (toNode.type == "END" && graph.edges[e].when == "") { fromId = graph.edges[e].from; }
        e = e + 1;
      }
      if (fromId == "") { return no("this workflow's end is reached by a branch — open it on the Workflows page and add the step there."); }
    }
    // The one plain edge out of the anchor is replaced by two.
    let oldTo = "";
    let branchy = false;
    let e2: int = 0;
    while (e2 < graph.edges.length) {
      if (graph.edges[e2].from == fromId) {
        if (graph.edges[e2].when != "") { branchy = true; }
        else { oldTo = graph.edges[e2].to; }
      }
      e2 = e2 + 1;
    }
    if (branchy) { return no("that step branches — open the workflow on the Workflows page and add the step where it belongs."); }
    let id = "s" + crypto.randomUUID().slice(0, 8);
    let anchorNode = stepOf(graph, fromId);
    let built = saidNode(kind, text, jsonText(call.args, "title").trim(), id, 0);
    if (built.id == "") {
      return no("\"" + kind + "\" is not a step kind — the kinds are agent, model, web_search, knowledge and http.");
    }
    // Placed just past its anchor; the canvas's tidy is a click away.
    let placed: WfNode = {
      id: built.id, type: built.type, name: built.name,
      x: anchorNode.x + 120.0, y: anchorNode.y + 140.0,
      instruction: built.instruction, agentId: built.agentId,
      serverId: built.serverId, tool: built.tool, args: built.args,
      url: built.url, method: built.method, body: built.body,
      query: built.query, test: built.test, needle: built.needle,
      subject: built.subject, schedule: built.schedule,
    };
    let nodes: WfNode[] = [];
    let n: int = 0;
    while (n < graph.nodes.length) { nodes.push(graph.nodes[n]); n = n + 1; }
    nodes.push(placed);
    let edges: WfEdge[] = [];
    let e3: int = 0;
    while (e3 < graph.edges.length) {
      let edge = graph.edges[e3];
      if (edge.from == fromId && edge.when == "" && edge.to == oldTo) {
        edges.push(edgeOf(fromId, id));
        if (oldTo != "") { edges.push(edgeOf(id, oldTo)); }
      } else {
        edges.push(edge);
      }
      e3 = e3 + 1;
    }
    if (oldTo == "") { edges.push(edgeOf(fromId, id)); }
    let grown: WfGraph = { nodes: nodes, edges: edges, view: graph.view };
    let stored = storeGraph(db, row, grown, row.tz, call.nowMs);
    if (!stored.ok) { return no(stored.error); }
    return yes("Added.\n\n" + describe(stored.row, true));
  }

  let node = stepOf(graph, jsonText(call.args, "step").trim());
  if (node.id == "") { return no("no step by that id or name — show_workflow lists them."); }

  if (call.name == "change_step") {
    let text = jsonText(call.args, "text").trim();
    let title = jsonText(call.args, "title").trim();
    if (text == "" && title == "") { return no("say what changes: text, a title, or both."); }
    if (text != "" && (node.type == "START" || node.type == "END" || node.type == "CONDITION" || node.type == "MCP")) {
      return no("a " + node.type + " step is edited on the Workflows page — text here changes agent, model, web_search, knowledge and http steps.");
    }
    let nodes: WfNode[] = [];
    let n: int = 0;
    while (n < graph.nodes.length) {
      nodes.push(graph.nodes[n].id == node.id ? withText(graph.nodes[n], text, title) : graph.nodes[n]);
      n = n + 1;
    }
    let changed: WfGraph = { nodes: nodes, edges: graph.edges, view: graph.view };
    let stored = storeGraph(db, row, changed, row.tz, call.nowMs);
    if (!stored.ok) { return no(stored.error); }
    return yes("Changed.\n\n" + describe(stored.row, true));
  }

  // remove_step.
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
      if (inFrom != "" || edge.when != "") { tangled = true; }
      inFrom = edge.from;
    }
    if (edge.from == node.id) {
      if (outTo != "" || edge.when != "") { tangled = true; }
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
    if (graph.nodes[n2].id != node.id) { nodes.push(graph.nodes[n2]); }
    n2 = n2 + 1;
  }
  let edges: WfEdge[] = [];
  let e5: int = 0;
  while (e5 < graph.edges.length) {
    let edge = graph.edges[e5];
    if (edge.from != node.id && edge.to != node.id) { edges.push(edge); }
    e5 = e5 + 1;
  }
  if (inFrom != "" && outTo != "") { edges.push(edgeOf(inFrom, outTo)); }
  let shrunk: WfGraph = { nodes: nodes, edges: edges, view: graph.view };
  let stored = storeGraph(db, row, shrunk, row.tz, call.nowMs);
  if (!stored.ok) { return no(stored.error); }
  return yes("Removed.\n\n" + describe(stored.row, true));
}
