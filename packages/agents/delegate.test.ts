// Delegation: an agent's children, offered to it as tools.
//
// The naming and the description are pure and tested directly. The refusals
// that matter — a cycle, a disabled child, the depth limit — are tested
// through a run, because they are decisions the run makes and not properties
// of a name.
//
//   cd packages/agents && lumen test delegate.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { AgentRow, ModelRow, ModelConfigRow, PromptRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "./schema.ts";
import { agentChildren, delegateToolName, delegateDescription, delegateSchema } from "./tools.ts";
import { AgentRun, runAgent, runAgentAt } from "./run.ts";
import { TURN_SEQ_NONE } from "./artifacts.ts";
import { noTracer } from "../tracing/tracing.ts";
import { Turn } from "./provider.ts";

// A run with no thread behind it.
function fresh(): Turn[] {
  let none: Turn[] = [];
  return none;
}
function fresh2(): string[] {
  let none: string[] = [];
  return none;
}
import { storeCredential } from "./credentials.ts";

let database: Db = sqlite();

function testKey(): string { return "0123456789abcdef0123456789abcdef"; }

function agent(id: string, name: string, description: string): void {
  let a: AgentRow = { id: id, agentName: name, description: description, modelConfigId: "c1", promptId: "p1", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "t" };
  persist(database, agentsMapping(), JSON.stringify(a));
}

function delegates(parent: string, child: string): void {
  execute(database, "INSERT INTO agent_sub_agents VALUES ('" + parent + "','" + child + "')");
}

function seeded(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_delegate_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  // The skills trio as well. `forgetMigrations` makes the whole plan pending
  // again, so a table left standing means 77 and 78 re-add a column that is
  // already there, SQLite refuses, and the plan STOPS — every migration after
  // it silently never runs. That was survivable while the columns these rows
  // are persisted with all arrived before 77; 82 and 86 arrive after it.
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  migrate(database, schemaPlan(database));

  let m: ModelRow = { id: "m1", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(m));
  let c: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.0, maxTokens: 32, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(database, modelConfigsMapping(database), JSON.stringify(c));
  let p: PromptRow = { id: "p1", promptName: "terse", version: 1, body: "Be brief.", createdAt: "t" };
  persist(database, promptsMapping(), JSON.stringify(p));
}

// --- naming -------------------------------------------------------------------

test("a child is offered under a name that says what calling it does", () => {
  expect(delegateToolName("scout") == "ask_scout");
  expect(delegateToolName("stock-desk") == "ask_stock-desk");
});

test("a name a provider would refuse is made safe rather than rejected", () => {
  // Agent names are chosen by whoever built the agent; they should not have to
  // know a provider's character set.
  expect(delegateToolName("stock desk") == "ask_stock_desk");
  expect(delegateToolName("ventes/fr") == "ask_ventes_fr");
  expect(delegateToolName("café") == "ask_caf__");
});

test("a child is described by its own row", () => {
  let a: AgentRow = { id: "a2", agentName: "scout", description: "searches the archive", modelConfigId: "c1", promptId: "p1", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "t" };
  expect(delegateDescription(a).indexOf("scout") >= 0);
  expect(delegateDescription(a).indexOf("searches the archive") >= 0);
});

test("a child with no description still says what it is", () => {
  let bare: AgentRow = { id: "a3", agentName: "scout", description: "", modelConfigId: "c1", promptId: "p1", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "t" };
  expect(delegateDescription(bare).indexOf("scout") >= 0);
});

test("a child takes a question, and is told it cannot see the conversation", () => {
  // A child is a separate run with its own context; a parent that assumes
  // otherwise asks half a question.
  expect(delegateSchema().indexOf("\"question\"") >= 0);
  expect(delegateSchema().indexOf("cannot see your conversation") >= 0);
  // And why that matters: a question missing a name gets answered about
  // something else. Observed, so it is spelled out to the model.
  expect(delegateSchema().indexOf("every name, place, quantity and date") >= 0);
  expect(delegateSchema().indexOf("\"required\":[\"question\"]") >= 0);
});

// --- which children a run can see ---------------------------------------------

test("children are read one level, not the whole tree", () => {
  seeded();
  agent("a1", "lead", "delegates");
  agent("a2", "scout", "searches");
  agent("a3", "deep", "the child's child");
  delegates("a1", "a2");
  delegates("a2", "a3");

  let first = agentChildren(database, "a1");
  expect(first.length == 1);
  expect(first[0].agentName == "scout");
  // a3 is a2's child, not a1's: a tree is walked a level at a time.
  expect(agentChildren(database, "a2").length == 1);
});

test("an agent with no children has none", () => {
  seeded();
  agent("a1", "lead", "alone");
  expect(agentChildren(database, "a1").length == 0);
});

// --- what a run refuses to delegate to ----------------------------------------

test("a cycle is named, not descended into", () => {
  // The schema accepts a cycle deliberately. The run is what refuses it, and
  // it should say so rather than descending to the depth limit and reporting
  // the wrong cause.
  //
  // Entered at depth 1 with the parent already on the path — which is exactly
  // what a delegation from a1 does — because at depth 0 nothing is above the
  // run and there is no cycle to find yet.
  seeded();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-0001", masterKey: testKey(), now: "t" });
  agent("a1", "lead", "delegates");
  agent("a2", "scout", "searches");
  delegates("a1", "a2");
  delegates("a2", "a1");

  let above: string[] = ["a1"];
  let child = runAgentAt(database, "a2", "anything", testKey(), { depth: 1, path: above, tracer: noTracer(), parentSpan: "", prior: fresh(), threadId: "", excludeChunks: fresh2(), modelConfigId: "", baseSeq: TURN_SEQ_NONE });
  expect(child.notes.length == 1);
  expect(child.notes[0].indexOf("lead") >= 0);
  expect(child.notes[0].indexOf("already in this chain") >= 0);

  // And from the top there is nothing to refuse yet: a1 -> a2 is a legal step.
  let top = runAgent(database, "a1", "anything", testKey());
  expect(top.notes.length == 0);
});

test("an agent that would delegate to itself is refused", () => {
  seeded();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-0001", masterKey: testKey(), now: "t" });
  agent("a1", "lead", "delegates");
  delegates("a1", "a1");
  let r = runAgent(database, "a1", "anything", testKey());
  expect(r.notes.length == 1);
  expect(r.notes[0].indexOf("already in this chain") >= 0);
});

test("past the depth limit an agent runs alone rather than not at all", () => {
  // Refusing the whole run because a child was out of reach would turn a
  // bounded plan into no answer.
  seeded();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-0001", masterKey: testKey(), now: "t" });
  agent("a1", "lead", "delegates");
  agent("a2", "scout", "searches");
  delegates("a1", "a2");

  let above: string[] = ["x1", "x2", "x3"];
  let deep = runAgentAt(database, "a1", "anything", testKey(), { depth: 3, path: above, tracer: noTracer(), parentSpan: "", prior: fresh(), threadId: "", excludeChunks: fresh2(), modelConfigId: "", baseSeq: TURN_SEQ_NONE });
  expect(deep.notes.length == 1);
  expect(deep.notes[0].indexOf("delegation limit") >= 0);
  // It still reached the provider — the run happened.
  expect(deep.agentName == "lead");
});

test("a disabled child is not offered, and the run says why", () => {
  seeded();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-0001", masterKey: testKey(), now: "t" });
  agent("a1", "lead", "delegates");
  let off: AgentRow = { id: "a2", agentName: "scout", description: "searches", modelConfigId: "c1", promptId: "p1", scriptImageId: "", isDefault: false, enabled: false, updatedAt: "t" };
  persist(database, agentsMapping(), JSON.stringify(off));
  delegates("a1", "a2");

  let r = runAgent(database, "a1", "anything", testKey());
  expect(r.notes.length == 1);
  expect(r.notes[0].indexOf("scout") >= 0);
  expect(r.notes[0].indexOf("disabled") >= 0);
});

test("a child that does not exist is simply not there", () => {
  seeded();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-0001", masterKey: testKey(), now: "t" });
  agent("a1", "lead", "delegates");
  delegates("a1", "gone");
  let r = runAgent(database, "a1", "anything", testKey());
  // A dangling link is nothing to report to the model: there is no agent to
  // describe, and the run is not wrong.
  expect(r.notes.length == 0);
});

test("the suite leaves nothing behind", () => {
  seeded();
  expect(dropTable(database, agentsMapping()).ok);
  database.close();
});
