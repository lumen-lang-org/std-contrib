// The run log: what is written, what a list costs, and what a trace holds.
//
//   cd packages/agents && lumen test runlog.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable, findById } from "../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../plume/migrate.ts";
import { schemaPlan } from "./schema.ts";
import { AgentRun, AgentStep } from "./run.ts";
import { Turn } from "./provider.ts";
import { RunRow, runsMapping, runStepsMapping, runsFull, runLogPlan, recordRun, runsOf } from "./runlog.ts";

let database: Db = sqlite();

function seeded(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_runlog_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
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
  let r: AgentRun = {
    ok: true, text: "37 units in Rotterdam.", body: "{}", status: 200,
    agentName: "parts-desk", promptVersion: 3, modelApiName: "mistral-small-latest",
    error: "", context: context, steps: steps, stopReason: "final", rounds: 2, notes: notes,
  };
  return r;
}

test("a run is written with its steps and read back whole", () => {
  seeded();
  let id = recordRun(database, "a1", "how many A-114?", sampleRun(2));
  expect(id != "");

  let document = findById(database, runsFull(database), id);
  expect(document != "");
  expect(document.indexOf("\"question\":\"how many A-114?\"") >= 0);
  expect(document.indexOf("\"answer\":\"37 units in Rotterdam.\"") >= 0);
  // Which prompt version and model served it, as they were at the time.
  expect(document.indexOf("\"promptVersion\":3") >= 0);
  expect(document.indexOf("mistral-small-latest") >= 0);
  // Both steps, nested.
  expect(document.indexOf("\"stepIndex\":0") >= 0);
  expect(document.indexOf("\"stepIndex\":1") >= 0);
  expect(document.indexOf("warehouse_stock") >= 0);
});

test("a run with no steps is a row and nothing else", () => {
  seeded();
  let id = recordRun(database, "a1", "hello", sampleRun(0));
  expect(id != "");
  let document = findById(database, runsFull(database), id);
  expect(document.indexOf("\"steps\":[]") >= 0 || document.indexOf("\"steps\":null") >= 0);
});

test("two runs get two ids", () => {
  seeded();
  let first = recordRun(database, "a1", "one", sampleRun(0));
  let second = recordRun(database, "a1", "two", sampleRun(0));
  expect(first != second);
});

test("the list is the transcript side only — no steps in it", () => {
  seeded();
  recordRun(database, "a1", "with tools", sampleRun(3));
  let listed = runsOf(database, "a1", 10);
  expect(listed.indexOf("\"question\":\"with tools\"") >= 0);
  // The steps are behind /runs/:id; a list view never pays for them.
  expect(listed.indexOf("stepIndex") < 0);
  expect(listed.indexOf("warehouse_stock") < 0);
});

test("an agent's list holds only that agent's runs", () => {
  seeded();
  recordRun(database, "a1", "mine", sampleRun(0));
  recordRun(database, "a2", "theirs", sampleRun(0));
  let listed = runsOf(database, "a1", 10);
  expect(listed.indexOf("\"question\":\"mine\"") >= 0);
  expect(listed.indexOf("\"question\":\"theirs\"") < 0);
});

test("a failed run is logged like any other", () => {
  // The runs an operator needs to read are mostly the ones that went wrong.
  seeded();
  let steps: AgentStep[] = [];
  let context: Turn[] = [];
  let notes: string[] = ["parts is disabled"];
  let bad: AgentRun = {
    ok: false, text: "", body: "", status: 0,
    agentName: "parts-desk", promptVersion: 3, modelApiName: "",
    error: "no usable credential for mistral",
    context: context, steps: steps, stopReason: "refused", rounds: 0, notes: notes,
  };
  let id = recordRun(database, "a1", "anything", bad);
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
