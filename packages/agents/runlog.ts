// What a run did, kept.
//
//   let id = recordRun(db, "a1", question, run);      // after runAgent
//   findById(db, runsFull(db), id)                    // the whole trace
//
// A no-code tool without a trace is unusable the first time an agent
// misbehaves: the person who assembled the agent has no source to read, so
// the record of what the model was told and what each tool returned is the
// only debugger they get.
//
// The two halves of a run stay separate here too. The `runs` row is the
// conversation's side — the question, the answer, what served it. The
// `run_steps` rows are the context's side — every tool call and its result.
// A transcript view reads the first and never joins the second; a trace view
// joins both.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRelation, DbRepository, field, repository, repositoryWith, hasMany, boolColumn, desc, persist, pageOrdered, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { AgentRun } from "./run.ts";

// One run. What was asked, what came back, and which rows actually served it —
// the prompt version and wire name as they were *at the time*, because the
// agent may point somewhere else tomorrow and the record should not move with
// it.
export type RunRow = {
  id: string,
  agentId: string,
  agentName: string,
  promptVersion: int,
  modelApiName: string,
  question: string,
  answer: string,
  ok: bool,
  stopReason: string,
  rounds: int,
  error: string,
  // Milliseconds since the epoch, as text: a 13-digit string sorts correctly
  // until the year 2286, and an int column would not hold it.
  createdAt: string,
};

export type RunStepRow = {
  id: string,
  runId: string,
  stepIndex: int,
  tool: string,
  server: string,
  args: string,
  result: string,
  ok: bool,
};

export function runsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentId", "agent_id", "text"),
    field("agentName", "agent_name", "text"),
    field("promptVersion", "prompt_version", "int"),
    field("modelApiName", "model_api_name", "text"),
    field("question", "question", "text"),
    field("answer", "answer", "text"),
    field("ok", "ok", "bool"),
    field("stopReason", "stop_reason", "text"),
    field("rounds", "rounds", "int"),
    field("error", "error", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("runs", "id", "id", fs);
}

export function runStepsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("runId", "run_id", "text"),
    field("stepIndex", "step_index", "int"),
    field("tool", "tool", "text"),
    field("server", "server", "text"),
    field("args", "args", "text"),
    field("result", "result", "text"),
    field("ok", "ok", "bool"),
  ];
  return repository("run_steps", "id", "id", fs);
}

// A run with its steps nested, one query. Takes the connection because the
// relation projects a bool, and SQLite and MySQL store those as 0 and 1.
export function runsFull(db: Db): DbRepository {
  let rs: DbRelation[] = [
    hasMany("steps", "run_steps", "id", "run_id",
            "step_index AS \"stepIndex\", tool, server, args, result, "
            + boolColumn(db, "ok") + " AS \"ok\""),
  ];
  return repositoryWith("runs", "id", "id", runsMapping().fields, rs);
}

// The tables, as steps for the same plan the rest of the schema uses.
// Versions continue schemaPlan's numbering; appending is the one safe change
// to an applied plan.
export function runLogPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("10", "runs", createTableSql(db, runsMapping())),
    migration("11", "run steps", createTableSql(db, runStepsMapping())),
    // Reads are "this agent's runs, newest first" and "this run's steps".
    migration("12", "runs by agent",
      "CREATE INDEX IF NOT EXISTS runs_by_agent ON runs (agent_id, created_at)"),
    migration("13", "steps by run",
      "CREATE INDEX IF NOT EXISTS steps_by_run ON run_steps (run_id, step_index)"),
  ];
  return plan;
}

// Write what happened. Returns the run's id, or "" when nothing was written —
// which a caller may treat as its own failure or not; losing the log line is
// not a reason to lose the answer.
export function recordRun(db: Db, agentId: string, question: string, run: AgentRun): string {
  let id = crypto.randomUUID();
  let row: RunRow = {
    id: id,
    agentId: agentId,
    agentName: run.agentName,
    promptVersion: run.promptVersion,
    modelApiName: run.modelApiName,
    question: question,
    answer: run.text,
    ok: run.ok,
    stopReason: run.stopReason,
    rounds: run.rounds,
    error: run.error,
    createdAt: `${Date.now()}`,
  };
  let written = persist(db, runsMapping(), JSON.stringify(row));
  if (!written.ok) { return ""; }

  let i: int = 0;
  while (i < run.steps.length) {
    let step: RunStepRow = {
      id: id + "-" + `${run.steps[i].index}`,
      runId: id,
      stepIndex: run.steps[i].index,
      tool: run.steps[i].tool,
      server: run.steps[i].server,
      args: run.steps[i].args,
      result: run.steps[i].result,
      ok: run.steps[i].ok,
    };
    persist(db, runStepsMapping(), JSON.stringify(step));
    i = i + 1;
  }
  return id;
}

// An agent's runs, newest first — the transcript side only. The steps are a
// second query away by id, which is the point: a list view never pays for
// them.
export function runsOf(db: Db, agentId: string, limit: int): string {
  let keys: DbOrder[] = [desc("created_at")];
  return pageOrdered(db, runsMapping(), "agent_id = " + db.placeholder, [agentId], keys, limit, 0);
}
