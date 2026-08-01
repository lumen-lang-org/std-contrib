// The run log: what is written, what a list costs, and what a trace holds.
//
//   cd packages/agents && lumen test runlog.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable, findById } from "../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../plume/migrate.ts";
import { schemaPlan } from "./schema.ts";
import { AgentRun, AgentStep } from "./run.ts";
import { RecordedSpan } from "../tracing/tracing.ts";
import { Retrieved } from "./knowledge.ts";
import { Turn } from "./provider.ts";
import { RunRow, runsMapping, runStepsMapping, runsFull, runLogPlan, recordRun, runsOf, ownedRun } from "./runlog.ts";

let database: Db = sqlite();

// An unscoped caller: no proxy in front, so no owner is checked. What every
// deployment without the trust gate is (owner.ts).
let noTags: string[] = [];

function seeded(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_runlog_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  // The skills trio as well. `forgetMigrations` makes the whole plan pending
  // again, so a table left standing means 77 and 78 re-add a column that is
  // already there, SQLite refuses, and the plan STOPS — every migration after
  // it silently never runs. That was survivable while the columns these rows
  // are persisted with all arrived before 77; 86 adds two to `runs` after it,
  // and the symptom was recordRun returning "" for no stated reason.
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP INDEX IF EXISTS runs_by_agent");
  execute(database, "DROP INDEX IF EXISTS steps_by_run");
  execute(database, "DROP TABLE IF EXISTS run_steps");
  execute(database, "DROP TABLE IF EXISTS runs");
  execute(database, "DROP TABLE IF EXISTS credentials");
  execute(database, "DROP TABLE IF EXISTS agents");
  execute(database, "DROP TABLE IF EXISTS mcp_servers");
  execute(database, "DROP TABLE IF EXISTS prompts");
  execute(database, "DROP TABLE IF EXISTS model_configs");
  execute(database, "DROP TABLE IF EXISTS models");
  let plan = schemaPlan(database);
  let extra = runLogPlan(database);
  let e: int = 0;
  while (e < extra.length) { plan.push(extra[e]); e = e + 1; }
  migrate(database, plan);
}

function sampleRun(withSteps: int): AgentRun {
  let steps: AgentStep[] = [];
  let i: int = 0;
  while (i < withSteps) {
    let s: AgentStep = { index: i, tool: "warehouse_stock", server: "parts", args: "{\"part\":\"A-114\"}", result: "37 units", ok: true };
    steps.push(s);
    i = i + 1;
  }
  let context: Turn[] = [];
  let notes: string[] = [];
  let spans: RecordedSpan[] = [];
  let noNames: string[] = [];
  let noPassages: Retrieved[] = [];
  let r: AgentRun = {
    ok: true, text: "37 units in Rotterdam.", body: "{}", status: 200,
    agentName: "parts-desk", promptVersion: 3, modelApiName: "mistral-small-latest",
    inputTokens: 120, outputTokens: 40,
    error: "", context: context, steps: steps, stopReason: "final", rounds: 2, notes: notes,
    calledTools: noNames, calledAgents: noNames, retrieved: noPassages, spans: spans,
  };
  return r;
}

test("a run is written with its steps and read back whole", () => {
  seeded();
  let id = recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "how many A-114?", run: sampleRun(2), modelChoiceId: "", routeNote: "" });
  expect(id != "");

  let document = findById(database, runsFull(database), id);
  expect(document != "");
  expect(document.indexOf("\"question\":\"how many A-114?\"") >= 0);
  expect(document.indexOf("\"answer\":\"37 units in Rotterdam.\"") >= 0);
  // Which prompt version and model served it, as they were at the time.
  expect(document.indexOf("\"promptVersion\":3") >= 0);
  expect(document.indexOf("mistral-small-latest") >= 0);
  // What it cost, which the provider counted and this used to throw away —
  // leaving no way to answer "how much has this tenant used" from these rows.
  expect(document.indexOf("\"inputTokens\":120") >= 0);
  expect(document.indexOf("\"outputTokens\":40") >= 0);
  // Both steps, nested.
  expect(document.indexOf("\"stepIndex\":0") >= 0);
  expect(document.indexOf("\"stepIndex\":1") >= 0);
  expect(document.indexOf("warehouse_stock") >= 0);
});

test("a run records which choice was in force and what the routing decided", () => {
  seeded();
  // The two columns migration 86 added, and for a while nobody wrote: they were
  // hardcoded to "" here while the values sat in the caller's hand, so the only
  // place a turn ever said which model choice answered it was one HTTP response
  // the client had already discarded. A silent fallback — a retired menu row, a
  // router that did not route, a dangling config — left no trace at all, and
  // MODEL-CHOICE.md's evaluation loop ("worth seeding from real traffic") had
  // nothing to read.
  let id = recordRun(database, {
    agentId: "a1", threadId: "t1", owner: "", question: "write me a plan",
    run: sampleRun(0), modelChoiceId: "ch-auto",
    routeNote: "routed to think: the question needs working through",
  });
  let document = findById(database, runsFull(database), id);
  expect(document.indexOf("\"modelChoiceId\":\"ch-auto\"") >= 0);
  expect(document.indexOf("routed to think") >= 0);

  // And "" stays "" — a door with no conversation in front of it chose nothing,
  // which is what every row written before the menu existed carries. A route
  // note invented for those would be a decision nobody made turning up in an
  // eval dataset.
  let bare = recordRun(database, {
    agentId: "a1", threadId: "", owner: "", question: "hello",
    run: sampleRun(0), modelChoiceId: "", routeNote: "",
  });
  let plain = findById(database, runsFull(database), bare);
  expect(plain.indexOf("\"modelChoiceId\":\"\"") >= 0);
  expect(plain.indexOf("\"routeNote\":\"\"") >= 0);
});

test("a run with no steps is a row and nothing else", () => {
  seeded();
  let id = recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "hello", run: sampleRun(0), modelChoiceId: "", routeNote: "" });
  expect(id != "");
  let document = findById(database, runsFull(database), id);
  expect(document.indexOf("\"steps\":[]") >= 0 || document.indexOf("\"steps\":null") >= 0);
});

test("two runs get two ids", () => {
  seeded();
  let first = recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "one", run: sampleRun(0), modelChoiceId: "", routeNote: "" });
  let second = recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "two", run: sampleRun(0), modelChoiceId: "", routeNote: "" });
  expect(first != second);
});

test("the list is the transcript side only — no steps in it", () => {
  seeded();
  recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "with tools", run: sampleRun(3), modelChoiceId: "", routeNote: "" });
  let listed = runsOf(database, "a1", noTags, 10);
  expect(listed.indexOf("\"question\":\"with tools\"") >= 0);
  // The steps are behind /runs/:id; a list view never pays for them.
  expect(listed.indexOf("stepIndex") < 0);
  expect(listed.indexOf("warehouse_stock") < 0);
});

test("an agent's list holds only that agent's runs", () => {
  seeded();
  recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "mine", run: sampleRun(0), modelChoiceId: "", routeNote: "" });
  recordRun(database, { agentId: "a2", threadId: "", owner: "", question: "theirs", run: sampleRun(0), modelChoiceId: "", routeNote: "" });
  let listed = runsOf(database, "a1", noTags, 10);
  expect(listed.indexOf("\"question\":\"mine\"") >= 0);
  expect(listed.indexOf("\"question\":\"theirs\"") < 0);
});

// --- whose run it was ---------------------------------------------------------

test("a tag's run list holds only that tag's runs, on the agent they share", () => {
  seeded();
  // One agent, two tenants. The agent id is not a boundary — everybody runs
  // the same row — so without the owner clause this list was every tenant's
  // questions and answers.
  recordRun(database, { agentId: "a1", threadId: "t1", owner: "alice", question: "mine", run: sampleRun(0), modelChoiceId: "", routeNote: "" });
  recordRun(database, { agentId: "a1", threadId: "t2", owner: "bob", question: "theirs", run: sampleRun(0), modelChoiceId: "", routeNote: "" });

  let hers = runsOf(database, "a1", ["alice"], 10);
  expect(hers.indexOf("\"question\":\"mine\"") >= 0);
  expect(hers.indexOf("\"question\":\"theirs\"") < 0);
  // And unscoped still sees both, which is what the community edition is.
  expect(runsOf(database, "a1", noTags, 10).indexOf("\"question\":\"theirs\"") >= 0);
});

test("a run id is not authorisation to read the run", () => {
  seeded();
  // The messages POST hands `runId` back to whoever asked, and the document
  // holds the whole conversation.
  let hers = recordRun(database, { agentId: "a1", threadId: "t1", owner: "alice", question: "mine", run: sampleRun(2), modelChoiceId: "", routeNote: "" });

  expect(ownedRun(database, hers, ["alice"]) != "");
  // Not "forbidden": "" is a 404, the same answer a run that never happened
  // gets, because 403 would confirm the id names something real.
  expect(ownedRun(database, hers, ["bob"]) == "");
  expect(ownedRun(database, hers, noTags) != "");
  // A run written before there were owners belongs to nobody, and stays that
  // way — never folded into the first tag that asks.
  let legacy = recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "older", run: sampleRun(0), modelChoiceId: "", routeNote: "" });
  expect(ownedRun(database, legacy, ["alice"]) == "");
});

test("a failed run is logged like any other", () => {
  // The runs an operator needs to read are mostly the ones that went wrong.
  seeded();
  let steps: AgentStep[] = [];
  let context: Turn[] = [];
  let notes: string[] = ["parts is disabled"];
  let spans: RecordedSpan[] = [];
  let noNames: string[] = [];
  let noPassages: Retrieved[] = [];
  let bad: AgentRun = {
    ok: false, text: "", body: "", status: 0,
    agentName: "parts-desk", promptVersion: 3, modelApiName: "",
    inputTokens: 0, outputTokens: 0,
    error: "no usable credential for mistral",
    context: context, steps: steps, stopReason: "refused", rounds: 0, notes: notes,
    calledTools: noNames, calledAgents: noNames, retrieved: noPassages, spans: spans,
  };
  let id = recordRun(database, { agentId: "a1", threadId: "", owner: "", question: "anything", run: bad, modelChoiceId: "", routeNote: "" });
  expect(id != "");
  let document = findById(database, runsFull(database), id);
  expect(document.indexOf("no usable credential") >= 0);
  expect(document.indexOf("\"stopReason\":\"refused\"") >= 0);
});

test("the suite leaves nothing behind", () => {
  seeded();
  execute(database, "DROP TABLE IF EXISTS run_steps");
  expect(dropTable(database, runsMapping()).ok);
  database.close();
});
