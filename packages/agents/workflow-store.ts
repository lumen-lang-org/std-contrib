// Workflows: a graph of steps somebody keeps, and what happened when it ran.
//
// The rows only, as tasks.ts is the rows for scheduled tasks. The graph
// itself — what a node is, what makes one wrong, how a walk proceeds — lives
// in `packages/workflow` and knows nothing about databases or owners; this
// module is where a graph becomes somebody's: an owner, a name, a switch, a
// schedule, and a history of runs.
//
// A workflow is not a task. A task is one instruction fired on a schedule; a
// workflow is steps with edges between them, drawn on a canvas, walked in
// order. They share the schedule grammar (`compile`, tasks.ts) because a
// person says "every weekday at 08:00" identically to both — and nothing
// else. Separate tables, so neither can bend the other's shape.
//
// The graph is ONE column, the whole document, saved and read together.
// nuraly's service splits nodes and edges into their own tables behind six
// REST endpoints, and its client then needs an id-remapping dance to relate
// what it just POSTed to what it drew (persistence-mixin.ts). A document
// cannot half-save, cannot dangle, and is validated whole on every write —
// which matters more here, because a model authors these graphs as often as
// a person does.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, createTableSql, desc, field, listOrdered, listWhere, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { WfGraph, refuse as refuseGraph, startOf } from "../workflow/workflow.ts";
import { PAUSE_AFTER, RUN_TIMEOUT_MS, Scheduled, compile, isOnce, nextFire, onceInstant, stampMs, TaskRow } from "./tasks.ts";
import { knownZone } from "../cron/cron.ts";

// What a runaway workflow costs, as limits rather than hope — the same
// posture as tasks.ts, at the same numbers where the same thing is bounded.
export const MAX_WORKFLOWS_PER_OWNER: int = 10;
// How large a graph document may be on the wire. The per-field bounds live
// with the graph; this is the envelope, so a client cannot post a megabyte of
// nodes and have the refusal come from the parser.
export const MAX_GRAPH_CHARS: int = 65536;

export type WorkflowRow = {
  id: string,
  // Whose it is. Every read and every write is scoped by this.
  owner: string,
  // The agent an AGENT step with no agentId of its own runs as, and the agent
  // the run's conversation is filed under. Resolved at create, as tasks do.
  agentId: string,
  modelChoiceId: string,
  name: string,
  description: string,
  // The whole drawing: nodes, edges, viewport, as JSON text.
  graph: string,
  // "manual" — runs when somebody presses Run. "every" — fires on cronExpr.
  // "once" — fires at nextAt and is done. Decided by the START step's own
  // schedule words, never sent directly.
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

// One firing of one workflow. `steps` is the walk's own record — an array of
// {nodeId, type, status, ms, output, error} — stored as JSON and handed to
// the canvas as node statuses without a transform.
export type WorkflowRunRow = {
  id: string,
  workflowId: string,
  owner: string,
  // "running", "ok", "failed".
  status: string,
  input: string,
  answer: string,
  error: string,
  // The conversation the run's answer was filed in.
  threadId: string,
  steps: string,
  startedAt: string,
  endedAt: string,
};

export function workflowsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("agentId", "agent_id", "text"),
    field("modelChoiceId", "model_choice_id", "text"),
    field("name", "name", "text"),
    field("description", "description", "text"),
    field("graph", "graph", "text"),
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
  return repository("workflows", "id", "id", fs);
}

export function workflowRunsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("workflowId", "workflow_id", "text"),
    field("owner", "owner", "text"),
    field("status", "status", "text"),
    field("input", "input", "text"),
    field("answer", "answer", "text"),
    field("error", "error", "text"),
    field("threadId", "thread_id", "text"),
    field("steps", "steps", "text"),
    field("startedAt", "started_at", "text"),
    field("endedAt", "ended_at", "text"),
  ];
  return repository("workflow_runs", "id", "id", fs);
}

export function workflowsPlan(db: Db): Migration[] {
  // 101: tasks.ts owns 99, discover.ts owns 100, and a migration that sorts
  // below one already applied refuses the whole plan. Check
  // `SELECT version FROM plume_schema_history ORDER BY installed_rank DESC`
  // before choosing a number, not after.
  return [
    migration("101", "workflows: steps somebody drew",
      createTableSql(db, workflowsMapping())),
    migration("101.1", "and what happened when they ran",
      createTableSql(db, workflowRunsMapping())),
  ];
}

// ---------------------------------------------------------------------------
// The graph column, read and refused
// ---------------------------------------------------------------------------

export type ParsedGraph = {
  ok: bool,
  graph: WfGraph,
  error: string,
};

/** The graph column as a graph, or why it is not one.
 *
 *  The parse is typed and the failure is caught here so that everywhere else
 *  reads `ok` instead of wrapping a try — and so the sentence a model gets
 *  back names the problem rather than quoting a parser. */
export function parseGraph(text: string): ParsedGraph {
  let none: WfGraph = { nodes: [], edges: [], view: { x: 0.0, y: 0.0, zoom: 1.0 } };
  if (text.length > MAX_GRAPH_CHARS) {
    let big: ParsedGraph = { ok: false, graph: none,
      error: "that graph is " + `${text.length}` + " characters — the most a workflow may carry is " + `${MAX_GRAPH_CHARS}` };
    return big;
  }
  try {
    let graph = JSON.parse<WfGraph>(text);
    let good: ParsedGraph = { ok: true, graph: graph, error: "" };
    return good;
  } catch (e) {
    let bad: ParsedGraph = { ok: false, graph: none,
      error: "that is not a workflow graph — nodes, edges and a view are required, every field present" };
    return bad;
  }
}

/** What the START step's words mean for the row's schedule half.
 *
 *  "" is a workflow run by hand. "every ..." compiles through the same
 *  grammar tasks use; "on ... at ..." is a single instant. The zone must
 *  already be on the row. */
export type WfTiming = {
  ok: bool,
  kind: string,
  expr: string,
  at: string,
  error: string,
};

export function timingOf(graph: WfGraph, zone: string, nowMs: number): WfTiming {
  let said = startOf(graph).schedule.trim();
  if (said == "") {
    let manual: WfTiming = { ok: true, kind: "manual", expr: "", at: "", error: "" };
    return manual;
  }
  if (isOnce(said)) {
    let once = onceInstant(said, zone == "" ? "UTC" : zone, nowMs);
    if (!once.ok) {
      let bad: WfTiming = { ok: false, kind: "", expr: "", at: "", error: once.error };
      return bad;
    }
    let single: WfTiming = { ok: true, kind: "once", expr: "", at: once.at, error: "" };
    return single;
  }
  let compiled = compile(said);
  if (!compiled.ok) {
    let bad: WfTiming = { ok: false, kind: "", expr: "", at: "", error: compiled.error };
    return bad;
  }
  let every: WfTiming = { ok: true, kind: "every", expr: compiled.expr, at: "", error: "" };
  return every;
}

/** Everything wrong with a workflow somebody just described, or "".
 *
 *  The graph's own rules are `packages/workflow`'s and are not repeated here
 *  — this adds only what a graph cannot know: the owner, the agent, the zone
 *  and the schedule's meaning. */
export function refuseWorkflow(row: WorkflowRow): string {
  if (row.name.trim() == "") { return "a workflow needs a name for the list"; }
  if (row.agentId == "") { return "a workflow needs an agent to run as"; }
  if (row.tz != "" && !knownZone(row.tz)) {
    return "\"" + row.tz + "\" is not a timezone this server knows";
  }
  let parsed = parseGraph(row.graph);
  if (!parsed.ok) { return parsed.error; }
  let wrong = refuseGraph(parsed.graph);
  if (wrong != "") { return wrong; }
  if (row.kind != "manual" && row.kind != "every" && row.kind != "once") {
    return "a workflow runs \"manual\", \"every\" or \"once\", not \"" + row.kind + "\"";
  }
  if (row.kind == "every" && row.cronExpr == "") { return "a repeating workflow needs a schedule"; }
  if (row.kind == "once" && stampMs(row.nextAt) <= 0.0) { return "a one-off workflow needs the instant it should run at"; }
  return "";
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function emptyWorkflow(): WorkflowRow {
  let none: WorkflowRow = {
    id: "", owner: "", agentId: "", modelChoiceId: "", name: "", description: "",
    graph: "", kind: "", cronExpr: "", tz: "", nextAt: "", runningSince: "",
    enabled: false, failures: 0, pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: 0, createdAt: "", updatedAt: "",
  };
  return none;
}

/** This owner's workflows, most recently touched first. */
export function workflowsOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [desc("updated_at")];
  return listOrdered(db, workflowsMapping(), "owner = " + db.placeholder, [owner], keys);
}

export function enabledWorkflowCount(db: Db, owner: string): int {
  let rows = JSON.parse<WorkflowRow[]>(listWhere(db, workflowsMapping(),
    "owner = " + db.placeholder, [owner]));
  let n: int = 0;
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].enabled) { n = n + 1; }
    i = i + 1;
  }
  return n;
}

/** One workflow's runs, newest first. */
export function workflowRunsOf(db: Db, workflowId: string, owner: string): string {
  let keys: DbOrder[] = [desc("started_at")];
  return listOrdered(db, workflowRunsMapping(),
    "workflow_id = " + db.placeholder + " AND owner = " + placeholderAt(db, 2),
    [workflowId, owner], keys);
}

/** The next firing after `afterMs` for a scheduled workflow.
 *
 *  Through the task's own function, by lending it the row's schedule half —
 *  one implementation of "when does cron fire next in this zone", not two. */
export function nextWorkflowFire(row: WorkflowRow, afterMs: number): Scheduled {
  let asTask: TaskRow = {
    id: row.id, owner: row.owner, agentId: row.agentId, modelChoiceId: "",
    title: row.name, instruction: "-",
    kind: row.kind, cronExpr: row.cronExpr, tz: row.tz, nextAt: row.nextAt,
    runningSince: "", enabled: true, failures: 0, pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: 0, createdAt: "", updatedAt: "",
  };
  return nextFire(asTask, afterMs);
}

/** The same workflow with a different next firing — records are immutable, so
 *  "set one field" is "build the row again", written once. */
export function withWorkflowNextAt(row: WorkflowRow, at: string): WorkflowRow {
  let moved: WorkflowRow = {
    id: row.id, owner: row.owner, agentId: row.agentId,
    modelChoiceId: row.modelChoiceId, name: row.name,
    description: row.description, graph: row.graph, kind: row.kind,
    cronExpr: row.cronExpr, tz: row.tz, nextAt: at,
    runningSince: row.runningSince, enabled: row.enabled,
    failures: row.failures, pausedReason: row.pausedReason,
    lastRunAt: row.lastRunAt, lastRunId: row.lastRunId,
    lastStatus: row.lastStatus, lastError: row.lastError,
    runCount: row.runCount, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
  return moved;
}

// ---------------------------------------------------------------------------
// Claiming — the same shape as tasks.ts, against the other table, for the
// same reasons: SKIP LOCKED so two runners cannot fire one workflow twice,
// and the claim stamped in the same statement so a crash cannot re-fire on
// every tick forever.
// ---------------------------------------------------------------------------

/** One due scheduled workflow, claimed, or an empty row. */
export function claimDueWorkflow(db: Db, nowMs: number): WorkflowRow {
  let none = emptyWorkflow();
  let now = `${nowMs}`;
  let stale = `${(nowMs as i64) - (RUN_TIMEOUT_MS as i64)}`;
  let sql = "UPDATE workflows SET running_since = " + db.placeholder
    + " WHERE id = (SELECT id FROM workflows"
    // No kind test: a manual workflow ordinarily has no next_at and is never
    // due, and "run now" IS a next_at — the one write that makes it due once.
    // The first version excluded kind='manual' here, and Run soon on an
    // unscheduled workflow was silently never claimed.
    + " WHERE enabled = true AND next_at <> '' AND next_at <= " + placeholderAt(db, 2)
    + " AND (running_since = '' OR running_since < " + placeholderAt(db, 3) + ")"
    + " ORDER BY next_at LIMIT 1 FOR UPDATE SKIP LOCKED)"
    + " RETURNING id, owner, agent_id, model_choice_id, name, description,"
    + " graph, kind, cron_expr, tz, next_at, failures, run_count";
  if (!db.query(sql, [now, now, stale])) { return none; }
  if (db.rows() == 0) { return none; }
  let got: WorkflowRow = {
    id: db.value(0, 0),
    owner: db.value(0, 1),
    agentId: db.value(0, 2),
    modelChoiceId: db.value(0, 3),
    name: db.value(0, 4),
    description: db.value(0, 5),
    graph: db.value(0, 6),
    kind: db.value(0, 7),
    cronExpr: db.value(0, 8),
    tz: db.value(0, 9),
    nextAt: db.value(0, 10),
    runningSince: now,
    enabled: true,
    failures: parseInt(db.value(0, 11), 10) ?? 0,
    pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: parseInt(db.value(0, 12), 10) ?? 0,
    createdAt: "", updatedAt: "",
  };
  return got;
}

/** A run that worked: claim released, schedule moved on, a one-off switched
 *  off rather than left as a workflow that can never fire again. A manual
 *  workflow has no next firing and stays enabled. */
export function markWorkflowRan(db: Db, row: WorkflowRow, runId: string, nowMs: number): void {
  let ahead = nextWorkflowFire(row, nowMs);
  let stillOn = row.kind == "manual" || (row.kind == "every" && ahead.ok);
  let again = row.kind == "every" && ahead.ok ? ahead.at : "";
  let sql = "UPDATE workflows SET running_since = '', failures = 0, paused_reason = '',"
    + " last_run_at = " + db.placeholder
    + ", last_run_id = " + placeholderAt(db, 2)
    + ", last_status = 'ok', last_error = ''"
    + ", run_count = run_count + 1"
    + ", enabled = " + placeholderAt(db, 3)
    + ", next_at = " + placeholderAt(db, 4)
    + ", updated_at = " + placeholderAt(db, 5)
    + " WHERE id = " + placeholderAt(db, 6);
  let now = `${nowMs}`;
  db.query(sql, [now, runId, stillOn ? "true" : "false", again, now, row.id]);
}

/** A run that did not work: counted, and at PAUSE_AFTER the workflow switches
 *  itself off with the reason on it. */
export function markWorkflowFailed(db: Db, row: WorkflowRow, why: string, nowMs: number): void {
  let failures = row.failures + 1;
  let done = failures >= PAUSE_AFTER;
  let ahead = nextWorkflowFire(row, nowMs);
  let scheduled = row.kind == "every" && ahead.ok;
  let stillOn = !done && (row.kind == "manual" || scheduled);
  let sql = "UPDATE workflows SET running_since = '', failures = " + db.placeholder
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
    stillOn && scheduled ? ahead.at : "", now, row.id]);
}
