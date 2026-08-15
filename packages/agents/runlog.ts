import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, dialectType, persist, findById, pageOrdered, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { AgentRun } from "./run.ts";
import { ownerClause, documentIsOwned } from "./owner.ts";
import { runRepository } from "./routes/runs/entities/run.entity.ts";
import { runStepRepository } from "./routes/runs/entities/run-step.entity.ts";

export type RunRow = {
  id: string,
  agentId: string,
  threadId: string,
  owner: string,
  agentName: string,
  promptVersion: int,
  modelApiName: string,
  question: string,
  answer: string,
  ok: bool,
  stopReason: string,
  rounds: int,
  error: string,
  inputTokens: int,
  outputTokens: int,
  modelChoiceId: string,
  routeNote: string,
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

function runsMappingV1(): DbRepository {
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
  return repository({ table: "runs", idField: "id", idColumn: "id", fields: fs });
}

export function runsMapping(): DbRepository {
  return repository({
    table: "runs",
    idField: "id",
    idColumn: "id",
    fields: runRepository().fields,
  });
}

export function runStepsMapping(): DbRepository {
  return runStepRepository();
}

export function runsFull(db: Db): DbRepository {
  return runRepository();
}

export function runLogPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("10", "runs", createTableSql(db, runsMappingV1())),
    migration("11", "run steps", createTableSql(db, runStepsMapping())),
    migration("12", "runs by agent",
      "CREATE INDEX IF NOT EXISTS runs_by_agent ON runs (agent_id, created_at)"),
    migration("13", "steps by run",
      "CREATE INDEX IF NOT EXISTS steps_by_run ON run_steps (run_id, step_index)"),
    migration("73", "a run names its thread",
      "ALTER TABLE runs ADD COLUMN thread_id " + db.textType + " NOT NULL DEFAULT ''"),
    migration("74", "a run has an owner",
      "ALTER TABLE runs ADD COLUMN owner " + db.textType + " NOT NULL DEFAULT ''"),
    migration("75", "a run's input tokens",
      "ALTER TABLE runs ADD COLUMN input_tokens " + dialectType(db, "int") + " NOT NULL DEFAULT 0"),
    migration("76", "a run's output tokens",
      "ALTER TABLE runs ADD COLUMN output_tokens " + dialectType(db, "int") + " NOT NULL DEFAULT 0"),
    migration("86.1", "a run names the choice that was in force",
      "ALTER TABLE runs ADD COLUMN model_choice_id " + db.textType + " NOT NULL DEFAULT ''"),
    migration("86.2", "a run says what the routing decided",
      "ALTER TABLE runs ADD COLUMN route_note " + db.textType + " NOT NULL DEFAULT ''"),
    migration("91", "runs are found by owner",
      "CREATE INDEX IF NOT EXISTS runs_by_owner ON runs (owner, created_at)"),
  ];
  return plan;
}

export type RunRecord = {
  agentId: string,
  threadId: string,
  owner: string,
  question: string,
  run: AgentRun,
  modelChoiceId: string,
  routeNote: string,
};

export function recordRun(db: Db, wrote: RunRecord): string {
  let id = crypto.randomUUID();
  let run = wrote.run;
  let row: RunRow = {
    id: id,
    agentId: wrote.agentId,
    threadId: wrote.threadId,
    owner: wrote.owner,
    agentName: run.agentName,
    promptVersion: run.promptVersion,
    modelApiName: run.modelApiName,
    question: wrote.question,
    answer: run.text,
    ok: run.ok,
    stopReason: run.stopReason,
    rounds: run.rounds,
    error: run.error,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    modelChoiceId: wrote.modelChoiceId,
    routeNote: wrote.routeNote,
    createdAt: `${Date.now()}`,
  };
  let written = persist(db, runsMapping(), JSON.stringify(row));
  if (!written.ok) {
    return "";
  }

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
    let wroteStep = persist(db, runStepsMapping(), JSON.stringify(step));
    if (!wroteStep.ok) {
      console.error("recordRun: step " + `${run.steps[i].index}` + " of run " + id + " was not saved: " + wroteStep.error);
    }
    i = i + 1;
  }
  return id;
}

export function runsOf(db: Db, agentId: string, tags: string[], limit: int): string {
  let keys: DbOrder[] = [{ column: "created_at", direction: "desc" }];
  let where = "agent_id = " + placeholderAt(db, 1);
  let args: string[] = [agentId];
  let mine = ownerClause(db, tags, 2);
  if (mine != "") {
    where = where + " AND " + mine;
    let i: int = 0;
    while (i < tags.length) {
      args.push(tags[i]);
      i = i + 1;
    }
  }
  return pageOrdered(db, runsMapping(), {
    where: where,
    args: args,
    order: keys,
    limit: limit,
    offset: 0,
  });
}

export function ownedRun(db: Db, runId: string, tags: string[]): string {
  let document = findById(db, runsFull(db), runId);
  if (document == "") {
    return "";
  }
  if (!documentIsOwned(document, tags)) {
    return "";
  }
  return document;
}
