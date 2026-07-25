// Which tools an agent gets, decided by rows.
//
// Nothing here reaches a live MCP server: every case is one where mounting
// should stop before it opens a connection, or where it should come back with
// the reason rather than with nothing. A run against a real server is
// examples/mount-mcp.ts.
//
//   cd packages/agents && lumen test tools.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, McpServerRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "./schema.ts";
import { Mounted, mountTools, toolSpecs, callMounted, serverOf, mountedIndex, agentServers } from "./tools.ts";

let database: Db = sqlite();

function seeded(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_tools_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  migrate(database, schemaPlan(database));

  let a: AgentRow = { id: "a1", agentName: "researcher", description: "d", modelConfigId: "c1", promptId: "p1", enabled: true, updatedAt: "t" };
  persist(database, agentsMapping(), JSON.stringify(a));
}

function server(id: string, name: string, transport: string, endpoint: string, enabled: bool): void {
  let s: McpServerRow = { id: id, serverName: name, transport: transport, endpoint: endpoint, enabled: enabled };
  persist(database, mcpServersMapping(), JSON.stringify(s));
}

function link(agentId: string, serverId: string): void {
  execute(database, "INSERT INTO agent_mcp_servers VALUES ('" + agentId + "','" + serverId + "')");
}

test("an agent with no servers has no tools and nothing to report", () => {
  seeded();
  let mounted = mountTools(database, "a1");
  expect(mounted.tools.length == 0);
  expect(mounted.servers.length == 0);
  expect(mounted.problems.length == 0);
});

test("only the servers linked to this agent are read", () => {
  seeded();
  server("s1", "mine", "http", "http://127.0.0.1:1", true);
  server("s2", "someone-elses", "http", "http://127.0.0.1:1", true);
  link("a1", "s1");
  let found = agentServers(database, "a1");
  expect(found.length == 1);
  expect(found[0].serverName == "mine");
});

test("a disabled server is named, not silently skipped", () => {
  seeded();
  server("s1", "filesystem", "http", "http://127.0.0.1:1", false);
  link("a1", "s1");
  let mounted = mountTools(database, "a1");
  expect(mounted.tools.length == 0);
  expect(mounted.problems.length == 1);
  expect(mounted.problems[0].indexOf("filesystem") >= 0);
  expect(mounted.problems[0].indexOf("disabled") >= 0);
});

test("a stdio server says what is missing, rather than failing to connect", () => {
  seeded();
  server("s1", "local-fs", "stdio", "mcp-fs", true);
  link("a1", "s1");
  let mounted = mountTools(database, "a1");
  expect(mounted.tools.length == 0);
  expect(mounted.problems[0].indexOf("subprocess") >= 0);
});

test("an unreachable server leaves the agent short a tool, and says so", () => {
  // Port 1 is not listening. The agent still runs; it just cannot use this.
  seeded();
  server("s1", "github", "http", "http://127.0.0.1:1", true);
  link("a1", "s1");
  let mounted = mountTools(database, "a1");
  expect(mounted.tools.length == 0);
  expect(mounted.problems.length == 1);
  expect(mounted.problems[0].indexOf("github") >= 0);
});

test("a tool the model invented is refused in words it can act on", () => {
  seeded();
  let mounted = mountTools(database, "a1");
  let answered = callMounted(mounted, "delete_everything", "{}");
  expect(!answered.ok);
  // The text goes back to the model, so it has to read as an instruction
  // rather than as a stack trace.
  expect(answered.text.indexOf("delete_everything") >= 0);
  expect(answered.text.indexOf("no tool named") >= 0);
  expect(answered.error.indexOf("delete_everything") >= 0);
});

test("nothing is mounted, so nothing is described", () => {
  seeded();
  expect(toolSpecs(mountTools(database, "a1")).length == 0);
  expect(mountedIndex(mountTools(database, "a1").tools, "anything") < 0);
  expect(serverOf(mountTools(database, "a1"), "anything") == "");
});

test("the suite leaves nothing behind", () => {
  seeded();
  expect(dropTable(database, agentsMapping()).ok);
  database.close();
});
