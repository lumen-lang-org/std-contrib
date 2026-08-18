import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, countWhere, createTableSql, executeWith, field, listOrdered, listWhere, placeholderAt, repository, skipLocked } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { WfGraph, refuse as refuseGraph, refuseDraft as refuseDrawing, startOf } from "../workflow/workflow.ts";
import { PAUSE_AFTER, RUN_TIMEOUT_MS, Scheduled, compile, isOnce, nextFire, onceInstant, stampMs, TaskRow } from "./tasks.ts";
import { knownZone } from "../cron/cron.ts";
import { workflowRepository } from "./routes/automation/workflows/entities/workflow.entity.ts";
import { workflowRunRepository } from "./routes/automation/workflows/entities/workflow-run.entity.ts";

export const MAX_WORKFLOWS_PER_OWNER: int = 10;
// What a run may be started with. A message, not a document.
export const MAX_RUN_INPUT: int = 4000;
export const MAX_GRAPH_CHARS: int = 65536;

export type WorkflowRow = {
  id: string,
  owner: string,
  agentId: string,
  modelChoiceId: string,
  name: string,
  description: string,
  graph: string,
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
  publishedGraph?: string,
  publishedAt?: string,
  createdAt: string,
  updatedAt: string,
};

export type WorkflowRunRow = {
  id: string,
  workflowId: string,
  owner: string,
  status: string,
  input: string,
  answer: string,
  error: string,
  threadId: string,
  steps: string,
  startedAt: string,
  endedAt: string,
};

function workflowsMappingV1(): DbRepository {
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
  return repository({ table: "workflows", idField: "id", idColumn: "id", fields: fs });
}

export function workflowsMapping(): DbRepository {
  return workflowRepository();
}

function workflowRunsMappingV1(): DbRepository {
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
  return repository({ table: "workflow_runs", idField: "id", idColumn: "id", fields: fs });
}

export function workflowRunsMapping(): DbRepository {
  return workflowRunRepository();
}

export function workflowsPlan(db: Db): Migration[] {
  return [
    migration("101", "workflows: steps somebody drew",
      createTableSql(db, workflowsMappingV1())),
    migration("101.1", "and what happened when they ran",
      createTableSql(db, workflowRunsMappingV1())),
    migration("107", "what production runs: the graph as last published",
      "ALTER TABLE workflows ADD COLUMN published_graph " + db.textType + " NOT NULL DEFAULT ''"),
    migration("107.1", "and when it was published",
      "ALTER TABLE workflows ADD COLUMN published_at " + db.textType + " NOT NULL DEFAULT ''"),
    migration("107.2", "what already runs is what is published",
      "UPDATE workflows SET published_graph = graph, published_at = updated_at"),
  ];
}

export type ParsedGraph = {
  ok: bool,
  graph: WfGraph,
  error: string,
};

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

/** What a workflow being EDITED must satisfy: the row's own fields, and a
 *  graph that is a graph. Whether every step is filled in is asked at publish
 *  — see refuseDraft — because a drawing in progress is the normal state of
 *  one being drawn, and refusing to store it loses the work. */
/** The instant this UTC day began, in milliseconds. */
export function dayBegan(nowMs: number): number {
  let day: number = 86400000.0;
  let whole = nowMs - (nowMs % day);
  return whole;
}

/** How many runs this owner has started today, finished or not.
 *
 *  Counted from the runs themselves rather than kept as a number on the owner:
 *  a counter is a second thing to keep true, and this table already knows. */
export function runsToday(db: Db, owner: string, nowMs: number): int {
  let sql = "SELECT COUNT(*) FROM workflow_runs WHERE owner = " + placeholderAt(db, 1)
    + " AND started_at >= " + placeholderAt(db, 2);
  if (!db.query(sql, [owner, `${dayBegan(nowMs)}`])) {
    return 0;
  }
  if (db.rows() == 0) {
    return 0;
  }
  return parseInt(db.value(0, 0), 10) ?? 0;
}

/** What a run started by hand should be given as {{input}}.
 *
 *  Beside the workflow rather than on it: the row is written by persist from
 *  JSON, and a member missing from one of the places that build a WorkflowRow
 *  would arrive as NULL in a column that may not be. */
export function setNextInput(db: Db, id: string, said: string): bool {
  let cleared = executeWith(db,
    "DELETE FROM workflow_inputs WHERE workflow_id = " + placeholderAt(db, 1), [id]);
  if (!cleared.ok) {
    return false;
  }
  if (said == "") {
    return true;
  }
  let written = executeWith(db,
    "INSERT INTO workflow_inputs (workflow_id, input) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ")", [id, said]);
  return written.ok;
}

/** Reads it and forgets it, so the next run on the clock starts empty as it
 *  always did — an input belongs to the press of the button, not the row. */
export function takeNextInput(db: Db, id: string): string {
  let sql = "SELECT input FROM workflow_inputs WHERE workflow_id = " + placeholderAt(db, 1);
  if (!db.query(sql, [id])) {
    return "";
  }
  if (db.rows() == 0) {
    return "";
  }
  let said = db.value(0, 0);
  executeWith(db, "DELETE FROM workflow_inputs WHERE workflow_id = " + placeholderAt(db, 1), [id]);
  return said;
}

export function refuseDraftWorkflow(row: WorkflowRow): string {
  return refuseRow(row, false);
}

export function refuseWorkflow(row: WorkflowRow): string {
  return refuseRow(row, true);
}

function refuseRow(row: WorkflowRow, ready: bool): string {
  if (row.name.trim() == "") {
    return "a workflow needs a name for the list";
  }
  if (row.agentId == "") {
    return "a workflow needs an agent to run as";
  }
  if (row.tz != "" && !knownZone(row.tz)) {
    return "\"" + row.tz + "\" is not a timezone this server knows";
  }
  let parsed = parseGraph(row.graph);
  if (!parsed.ok) {
    return parsed.error;
  }
  let wrong = ready ? refuseGraph(parsed.graph) : refuseDrawing(parsed.graph);
  if (wrong != "") {
    return wrong;
  }
  if (row.kind != "manual" && row.kind != "every" && row.kind != "once") {
    return "a workflow runs \"manual\", \"every\" or \"once\", not \"" + row.kind + "\"";
  }
  if (row.kind == "every" && row.cronExpr == "") {
    return "a repeating workflow needs a schedule";
  }
  if (row.kind == "once" && stampMs(row.nextAt) <= 0.0) {
    return "a one-off workflow needs the instant it should run at";
  }
  return "";
}

export function emptyWorkflow(): WorkflowRow {
  let none: WorkflowRow = {
    id: "", owner: "", agentId: "", modelChoiceId: "", name: "", description: "",
    graph: "", kind: "", cronExpr: "", tz: "", nextAt: "", runningSince: "",
    enabled: false, failures: 0, pausedReason: "",
    lastRunAt: "", lastRunId: "", lastStatus: "", lastError: "",
    runCount: 0, publishedGraph: "", publishedAt: "", createdAt: "", updatedAt: "",
  };
  return none;
}

export function workflowsOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [{ column: "updated_at", direction: "desc" }];
  return listOrdered(db, workflowsMapping(), {
    where: "owner = " + db.placeholder,
    args: [owner],
    order: keys,
  });
}

/** How many workflows this owner has running, or -1 when that cannot be
 *  counted, for the reason enabledCount in tasks.ts is counted. */
export function enabledWorkflowCount(db: Db, owner: string): int {
  return countWhere(db, workflowsMapping(),
    "owner = " + db.placeholder + " AND enabled = true", [owner]);
}

export function workflowRunsOf(db: Db, workflowId: string, owner: string): string {
  let keys: DbOrder[] = [{ column: "started_at", direction: "desc" }];
  return listOrdered(db, workflowRunsMapping(), {
    where: "workflow_id = " + db.placeholder + " AND owner = " + placeholderAt(db, 2),
    args: [workflowId, owner],
    order: keys,
  });
}

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
    runCount: row.runCount,
    publishedGraph: row.publishedGraph ?? "", publishedAt: row.publishedAt ?? "",
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
  return moved;
}

export function withGraph(row: WorkflowRow, bytes: string): WorkflowRow {
  let swapped: WorkflowRow = {
    id: row.id, owner: row.owner, agentId: row.agentId,
    modelChoiceId: row.modelChoiceId, name: row.name,
    description: row.description, graph: bytes, kind: row.kind,
    cronExpr: row.cronExpr, tz: row.tz, nextAt: row.nextAt,
    runningSince: row.runningSince, enabled: row.enabled,
    failures: row.failures, pausedReason: row.pausedReason,
    lastRunAt: row.lastRunAt, lastRunId: row.lastRunId,
    lastStatus: row.lastStatus, lastError: row.lastError,
    runCount: row.runCount,
    publishedGraph: row.publishedGraph ?? "", publishedAt: row.publishedAt ?? "",
    createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
  return swapped;
}

export function claimDueWorkflow(db: Db, nowMs: number): WorkflowRow {
  let none = emptyWorkflow();
  let now = `${nowMs}`;
  let stale = `${(nowMs as i64) - (RUN_TIMEOUT_MS as i64)}`;
  let sql = "UPDATE workflows SET running_since = " + db.placeholder
    + " WHERE id = (SELECT id FROM workflows"
    + " WHERE enabled = true AND next_at <> '' AND next_at <= " + placeholderAt(db, 2)
    + " AND (running_since = '' OR running_since < " + placeholderAt(db, 3) + ")"
    + " ORDER BY next_at LIMIT 1" + skipLocked(db) + ")"
    + " RETURNING id, owner, agent_id, model_choice_id, name, description,"
    + " graph, kind, cron_expr, tz, next_at, failures, run_count, published_graph";
  if (!db.query(sql, [now, now, stale])) {
    return none;
  }
  if (db.rows() == 0) {
    return none;
  }
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
    publishedGraph: db.value(0, 13), publishedAt: "",
    createdAt: "", updatedAt: "",
  };
  return got;
}

/** As markRan is for a task, and returning a fault for the same reason: an
 *  unrecorded run stays claimed and stays due. */
/** Put down, not failed. A day's budget spent says nothing about the drawing,
 *  so the failure count is untouched and the workflow is not paused — it takes
 *  its next turn on the clock, and a manual one waits to be asked again. */
export function markWorkflowShelved(db: Db, row: WorkflowRow, why: string, nowMs: number): string {
  let ahead = nextWorkflowFire(row, nowMs);
  let again = row.kind == "every" && ahead.ok ? ahead.at : "";
  let sql = "UPDATE workflows SET running_since = '',"
    + " last_run_at = " + db.placeholder
    + ", last_status = 'shelved', last_error = " + placeholderAt(db, 2)
    + ", next_at = " + placeholderAt(db, 3)
    + ", updated_at = " + placeholderAt(db, 4)
    + " WHERE id = " + placeholderAt(db, 5);
  let now = `${nowMs}`;
  if (!db.query(sql, [now, why, again, now, row.id])) {
    return "\"" + row.id + "\" was not put down, so it is still claimed and still due";
  }
  return "";
}

export function markWorkflowRan(db: Db, row: WorkflowRow, runId: string, nowMs: number): string {
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
  if (!db.query(sql, [now, runId, stillOn ? "true" : "false", again, now, row.id])) {
    return "the run of \"" + row.id + "\" was not recorded, so it is still claimed and still due";
  }
  return "";
}

export function markWorkflowFailed(db: Db, row: WorkflowRow, why: string, nowMs: number): string {
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
  if (!db.query(sql, [`${failures}`, now, why, stillOn ? "true" : "false", reason,
    stillOn && scheduled ? ahead.at : "", now, row.id])) {
    return "the failure of \"" + row.id + "\" was not recorded, so it is still claimed and still due";
  }
  return "";
}
