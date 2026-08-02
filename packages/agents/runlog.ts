// What a run did, kept.
//
//   let id = recordRun(db, { agentId: "a1", threadId: "", owner: "",
//                            question: question, run: run,
//                            modelChoiceId: "", routeNote: "" });  // after runAgent
//   ownedRun(db, id, tags)                            // the whole trace, if it is theirs
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
import { DbField, DbOrder, DbRelation, DbRepository, field, repository, repositoryWith, hasMany, boolColumn, desc, dialectType, persist, findById, pageOrdered, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { AgentRun } from "./run.ts";
import { ownerClause, documentIsOwned } from "./owner.ts";

// One run. What was asked, what came back, and which rows actually served it —
// the prompt version and wire name as they were *at the time*, because the
// agent may point somewhere else tomorrow and the record should not move with
// it.
export type RunRow = {
  id: string,
  agentId: string,
  // The conversation this run served, or "" for a bare `POST /agents/:id/run`
  // that belongs to no thread.
  threadId: string,
  // Whose run it is, carried on the row rather than joined through the thread:
  // a run may have no thread, and the messages POST hands its `runId` straight
  // to the caller — so the guard on `/runs/:id` needs the tag here or it has
  // nothing to compare (GATEWAY.md). "" is unowned, as everywhere else.
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
  // What the run cost. The provider counts these and every run already had
  // them in hand; they were read off the reply and dropped, so the only way to
  // answer "how much has this tenant used" was to ask the provider's own
  // dashboard, which does not know about tenants. Kept per row because
  // accounting is a sum over rows, and a counter cannot be recomputed.
  inputTokens: int,
  outputTokens: int,
  // Which menu row was in force, and what the routing decided.
  //
  // `modelApiName` above already records WHAT answered, which makes a routed
  // round half-auditable on its own; these two say WHY. Without them a router
  // is a classifier whose mistakes are invisible — and the rounds where a user
  // re-asked immediately after a fast answer are exactly the dataset an eval
  // wants seeded from (MODEL-CHOICE.md, "Evaluation").
  //
  // "" for both on a round nobody chose for and no router touched, which is
  // every row written before this and every unrouted round after it.
  modelChoiceId: string,
  // One line, in words: which candidate key was picked, or why the fallback
  // took it. The router never blocks a run — every failure path leads to the
  // fallback config, silently to the user — so this is the only place a
  // silent decision is written down, and a silent fallback nobody recorded is
  // the failure mode the office converter's own fallback comment warns about.
  routeNote: string,
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

// The shape migration 10 recorded, frozen — the `modelsMappingV1` precedent in
// schema.ts. Migration 10 generates its CREATE from a mapping and a
// migration's text is checksummed, so growing the live mapping below would
// rewrite 10 and every database that has already run it would refuse the whole
// plan. New columns are an ALTER at a new version, never an edit here.
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
  return repository("runs", "id", "id", fs);
}

export function runsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentId", "agent_id", "text"),
    // All four added after 10 shipped, so they arrive as ALTERs at 73 to 76.
    field("threadId", "thread_id", "text"),
    field("owner", "owner", "text"),
    field("inputTokens", "input_tokens", "int"),
    field("outputTokens", "output_tokens", "int"),
    // And two more at 86.1 and 86.2, for the same reason.
    field("modelChoiceId", "model_choice_id", "text"),
    field("routeNote", "route_note", "text"),
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
    migration("10", "runs", createTableSql(db, runsMappingV1())),
    migration("11", "run steps", createTableSql(db, runStepsMapping())),
    // Reads are "this agent's runs, newest first" and "this run's steps".
    migration("12", "runs by agent",
      "CREATE INDEX IF NOT EXISTS runs_by_agent ON runs (agent_id, created_at)"),
    migration("13", "steps by run",
      "CREATE INDEX IF NOT EXISTS steps_by_run ON run_steps (run_id, step_index)"),
    // Which conversation a run served, and whose it was. Two facts, two
    // migrations. Existing rows get "" for both: they predate threads on the
    // run row and they predate owners, and one spelling of "unowned" is what
    // keeps the guard a plain equality.
    migration("73", "a run names its thread",
      "ALTER TABLE runs ADD COLUMN thread_id " + db.textType + " NOT NULL DEFAULT ''"),
    migration("74", "a run has an owner",
      "ALTER TABLE runs ADD COLUMN owner " + db.textType + " NOT NULL DEFAULT ''"),
    // What it cost. 0 on the rows written before this, which is honest: they
    // did spend tokens and nothing recorded how many, and a usage sum must not
    // invent a number for them.
    migration("75", "a run's input tokens",
      "ALTER TABLE runs ADD COLUMN input_tokens " + dialectType(db, "int") + " NOT NULL DEFAULT 0"),
    migration("76", "a run's output tokens",
      "ALTER TABLE runs ADD COLUMN output_tokens " + dialectType(db, "int") + " NOT NULL DEFAULT 0"),
    // Why this model answered, beside the `model_api_name` that already says
    // which one did. Two facts, two migrations, under one number as 86.1 and
    // 86.2 to match MODEL-CHOICE.md's table — a dotted version is ordered
    // numerically, so both land after 85.
    //
    // "" on every existing row and honestly so: those rounds ran before there
    // was anything to choose, and a route note invented for them would be a
    // decision nobody made showing up in an eval dataset.
    migration("86.1", "a run names the choice that was in force",
      "ALTER TABLE runs ADD COLUMN model_choice_id " + db.textType + " NOT NULL DEFAULT ''"),
    migration("86.2", "a run says what the routing decided",
      "ALTER TABLE runs ADD COLUMN route_note " + db.textType + " NOT NULL DEFAULT ''"),
    // "how many runs has this owner filed since midnight" is asked on every
    // guest send (usage.ts, `runsSince`), and without this it is a scan of
    // every tenant's runs to count one tenant's day.
    //
    // 91, not 86.3: the deployed history's high-water is 90.9 (schema.ts), and
    // the boot-time migrate() refuses any unrecorded version below it — an
    // 86.3 here reads as two branches merging and stops the engine from
    // serving at all. Same trap schema.ts documents at its own 88/9 note.
    migration("91", "runs are found by owner",
      "CREATE INDEX IF NOT EXISTS runs_by_owner ON runs (owner, created_at)"),
  ];
  return plan;
}

// What a log line is written from. A record because four of these five are
// strings: an argument list would let a caller file a question under a thread
// id and nothing would notice.
export type RunRecord = {
  agentId: string,
  // "" when no thread asked — a bare `POST /agents/:id/run`.
  threadId: string,
  // The thread's owner when there is one, the caller's own tag when there is
  // not, and "" when nothing is scoped.
  owner: string,
  question: string,
  run: AgentRun,
  // Which menu row was in force, and why the model that answered was the one
  // that did. Both "" for a door with no conversation in front of it.
  //
  // Passed in rather than derived from `run`, and that is the point: the run
  // knows only `modelApiName` — WHAT answered — and deriving a choice from it
  // would be a guess. "the run used c-gemini-flash" is not the claim "a person
  // chose Fast", and the second is the one an eval seeded from real traffic
  // reads (MODEL-CHOICE.md, "Evaluation"). `runInThreadWith` resolves both and
  // hands them back for exactly this.
  modelChoiceId: string,
  routeNote: string,
};

// Write what happened. Returns the run's id, or "" when nothing was written —
// which a caller may treat as its own failure or not; losing the log line is
// not a reason to lose the answer.
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
//
// Scoped in the WHERE, like the thread list and for the same reasons. An agent
// is shared — one row every tenant may run — so without the owner clause this
// route served every tenant's questions and answers to whoever asked first.
export function runsOf(db: Db, agentId: string, tags: string[], limit: int): string {
  let keys: DbOrder[] = [desc("created_at")];
  let where = "agent_id = " + placeholderAt(db, 1);
  let args: string[] = [agentId];
  let mine = ownerClause(db, tags, 2);
  if (mine != "") {
    where = where + " AND " + mine;
    let i: int = 0;
    while (i < tags.length) { args.push(tags[i]); i = i + 1; }
  }
  return pageOrdered(db, runsMapping(), where, args, keys, limit, 0);
}

// One run with its steps, for a caller allowed to read it, or "" — which the
// route reads as a 404, the same answer a run that never happened gets.
//
// The whole conversation is in this document, so it is guarded exactly as the
// thread it came from is: the messages POST hands `runId` to the caller, and
// an id that unlocks somebody else's transcript is not much of an id.
export function ownedRun(db: Db, runId: string, tags: string[]): string {
  let document = findById(db, runsFull(db), runId);
  if (document == "") { return ""; }
  if (!documentIsOwned(document, tags)) { return ""; }
  return document;
}
