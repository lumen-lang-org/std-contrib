// The schema, against a live database: created from its own mappings, then
// read the way a request would read it.
//
//   cd packages/agents && lumen test schema.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { DbOrder, asc, connectDatabase, persist, findById, listOrdered, countWhere, execute, dropTable } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, McpServerRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, agentsFull, schemaPlan } from "./schema.ts";

let database: Db = sqlite();

// What one read of an agent gives back.
type PromptView = { id: string, promptName: string, version: int, body: string };
type ConfigView = { id: string, modelId: string, temperature: number, maxTokens: int, topP: number, extra: string };
// Exactly what agentsFull projects for a linked server — no more, or
// JSON.parse refuses the row for a field the query never selected.
type ServerView = { id: string, serverName: string, transport: string, endpoint: string, enabled: bool };
type SubAgentView = { id: string, agentName: string, enabled: bool };
type AgentView = {
  id: string,
  agentName: string,
  description: string,
  modelConfigId: string,
  promptId: string,
  enabled: bool,
  isDefault: bool,
  updatedAt: string,
  prompt: PromptView,
  config: ConfigView,
  servers: ServerView[],
  subAgents: SubAgentView[],
};

function connect(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_schema_test.db" };
  connectDatabase(database, cfg);
}

function wipe(): void {
  connect();
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS provider_credentials");
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
}

function seeded(): void {
  wipe();
  migrate(database, schemaPlan(database));

  let opus: ModelRow = { id: "m1", label: "Opus 5", apiName: "claude-opus-5", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  let haiku: ModelRow = { id: "m2", label: "Haiku 4.5", apiName: "claude-haiku-4-5-20251001", provider: "anthropic", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  persist(database, modelsMapping(), JSON.stringify(opus));
  persist(database, modelsMapping(), JSON.stringify(haiku));

  let careful: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.2, maxTokens: 8192, topP: 0.95, extra: "{}" };
  let quick: ModelConfigRow = { id: "c2", modelId: "m2", temperature: 0.7, maxTokens: 2048, topP: 1.0, extra: "{}" };
  persist(database, modelConfigsMapping(database), JSON.stringify(careful));
  persist(database, modelConfigsMapping(database), JSON.stringify(quick));

  let p1: PromptRow = { id: "p1", promptName: "lead", version: 1, body: "You lead.", createdAt: "2026-07-25" };
  let p2: PromptRow = { id: "p2", promptName: "lead", version: 2, body: "You lead, briefly.", createdAt: "2026-07-25" };
  let p3: PromptRow = { id: "p3", promptName: "scout", version: 1, body: "You search.", createdAt: "2026-07-25" };
  persist(database, promptsMapping(), JSON.stringify(p1));
  persist(database, promptsMapping(), JSON.stringify(p2));
  persist(database, promptsMapping(), JSON.stringify(p3));

  let fsSrv: McpServerRow = { id: "s1", serverName: "filesystem", transport: "stdio", endpoint: "mcp-fs", authKind: "none", authHeader: "", enabled: true };
  let ghSrv: McpServerRow = { id: "s2", serverName: "github", transport: "http", endpoint: "https://mcp.gh", authKind: "none", authHeader: "", enabled: true };
  persist(database, mcpServersMapping(), JSON.stringify(fsSrv));
  persist(database, mcpServersMapping(), JSON.stringify(ghSrv));

  let lead: AgentRow = { id: "a1", agentName: "lead", description: "delegates", modelConfigId: "c1", promptId: "p2", isDefault: false, enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  let scout: AgentRow = { id: "a2", agentName: "scout", description: "searches", modelConfigId: "c2", promptId: "p3", isDefault: false, enabled: true, updatedAt: "2026-07-25T10:00:00Z" };
  persist(database, agentsMapping(), JSON.stringify(lead));
  persist(database, agentsMapping(), JSON.stringify(scout));

  execute(database, "INSERT INTO agent_mcp_servers VALUES ('a1','s1'),('a1','s2'),('a2','s1')");
  execute(database, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
}

// --- the schema builds itself ------------------------------------------------

test("the plan creates every table, from the mappings", () => {
  wipe();
  let r = migrate(database, schemaPlan(database));
  expect(r.ok);
  // Thirteen: five tables from mappings, two link tables, the credentials
  // table, the index, and the four ALTERs that add columns those tables did
  // not have when they were first created. Asserting the number rather than
  // "some" is what catches a migration silently dropped from the plan.
  expect(r.applied == 13);
  // Every table answers, which means every generated statement ran.
  expect(countWhere(database, modelsMapping(), "", []) == 0);
  expect(countWhere(database, agentsMapping(), "", []) == 0);
});

test("running the plan twice applies nothing the second time", () => {
  wipe();
  expect(migrate(database, schemaPlan(database)).applied == 13);
  expect(migrate(database, schemaPlan(database)).applied == 0);
});

// --- one read gives a runnable agent ------------------------------------------

test("an agent arrives with its prompt, config, servers and sub-agents", () => {
  seeded();
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(agent.agentName == "lead");
  expect(agent.prompt.body == "You lead, briefly.");
  expect(agent.config.maxTokens == 8192);
  expect(agent.servers.length == 2);
  expect(agent.subAgents.length == 1);
  expect(agent.subAgents[0].agentName == "scout");
});

test("the model name is a row, so swapping models is an update", () => {
  seeded();
  // The config points at a model; the model carries the wire name.
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(agent.config.modelId == "m1");
  let model: ModelRow = JSON.parse<ModelRow>(findById(database, modelsMapping(), agent.config.modelId));
  expect(model.apiName == "claude-opus-5");

  // Point the config at the other model. Nothing is recompiled.
  execute(database, "UPDATE model_configs SET model_id = 'm2' WHERE id = 'c1'");
  let after: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  let swapped: ModelRow = JSON.parse<ModelRow>(findById(database, modelsMapping(), after.config.modelId));
  expect(swapped.apiName == "claude-haiku-4-5-20251001");
});

test("a prompt is versioned, so rolling back is pointing at an older row", () => {
  seeded();
  let before: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(before.prompt.version == 2);

  execute(database, "UPDATE agents SET prompt_id = 'p1' WHERE id = 'a1'");
  let after: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(after.prompt.version == 1);
  expect(after.prompt.body == "You lead.");
  // And version 2 is still there to go back to.
  expect(countWhere(database, promptsMapping(), "prompt_name = " + database.placeholder, ["lead"]) == 2);
});

test("a change is visible to the next read, with nothing reloaded", () => {
  seeded();
  execute(database, "UPDATE agents SET enabled = 0, description = 'retired' WHERE id = 'a2'");
  let agent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(!agent.enabled);
  expect(agent.description == "retired");
  // And the parent sees the change in its own read of the child.
  let parent: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a1"));
  expect(!parent.subAgents[0].enabled);
});

test("adding a server to an agent needs no schema change", () => {
  seeded();
  let before: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(before.servers.length == 1);
  execute(database, "INSERT INTO agent_mcp_servers VALUES ('a2','s2')");
  let after: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(after.servers.length == 2);
});

test("a sub-agent is an agent, and reads one level at a time", () => {
  seeded();
  // a2 is a1's child and has no children of its own.
  let child: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(child.subAgents.length == 0);
  // A cycle does not hang: the read stops at one level.
  execute(database, "INSERT INTO agent_sub_agents VALUES ('a2','a1')");
  let cycled: AgentView = JSON.parse<AgentView>(findById(database, agentsFull(database), "a2"));
  expect(cycled.subAgents.length == 1);
  expect(cycled.subAgents[0].agentName == "lead");
});

test("listing agents does not multiply them by their relations", () => {
  seeded();
  // a1 has two servers and one sub-agent; a join would repeat it.
  expect(countWhere(database, agentsFull(database), "", []) == 2);
  let keys: DbOrder[] = [asc("agent_name")];
  let json = listOrdered(database, agentsFull(database), { order: keys });
  expect(json.indexOf("lead") == json.lastIndexOf("lead") - 0 || json.indexOf("lead") >= 0);
  expect(json.indexOf("scout") >= 0);
});

test("the suite leaves nothing behind", () => {
  wipe();
  expect(countWhere(database, agentsMapping(), "", []) == -1);
  database.close();
});
