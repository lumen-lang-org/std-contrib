import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute, dropTable } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { schemaPlan, credentialsMapping, agentsMapping, mcpServersMapping, promptsMapping, modelConfigsMapping, modelsMapping } from "./schema.ts";
import { McpTool } from "./mcp.ts";
import { forgetRoster, mcpRosterMapping, mcpRosterPlan, rememberRoster, rosterOf, rosterWithSwitches, MAX_REMEMBERED_TOOLS } from "./mcp-roster.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_roster_test.db" };
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
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP TABLE IF EXISTS auth_providers");
  execute(database, "DROP TABLE IF EXISTS script_images");
  dropTable(database, mcpRosterMapping());
  let plan = schemaPlan(database);
  let extra = mcpRosterPlan(database);
  let i: int = 0;
  while (i < extra.length) {
    plan.push(extra[i]);
    i = i + 1;
  }
  migrate(database, plan);
}

function tool(name: string, about: string): McpTool {
  let t: McpTool = { name: name, description: about, schema: "{\"type\":\"object\"}" };
  return t;
}

test("a connector that has never been listed has nothing to show", () => {
  fresh();
  let held = rosterOf(database, "linear");
  expect(held.tools == "[]");
  expect(held.listedAt == "");
});

test("a listing is kept, dated, and comes back", () => {
  fresh();
  let tools: McpTool[] = [];
  tools.push(tool("create_issue", "File an issue"));
  tools.push(tool("list_cycles", "What a team is working on"));
  rememberRoster(database, "linear", tools, "t1");

  let held = rosterOf(database, "linear");
  expect(held.listedAt == "t1");
  expect(held.tools.indexOf("create_issue") >= 0);
  expect(held.tools.indexOf("What a team is working on") >= 0);
  expect(held.tools.indexOf("\"type\"") < 0);
});

test("a later listing replaces the earlier one", () => {
  fresh();
  let first: McpTool[] = [];
  first.push(tool("old_name", ""));
  rememberRoster(database, "linear", first, "t1");
  let second: McpTool[] = [];
  second.push(tool("new_name", ""));
  rememberRoster(database, "linear", second, "t2");

  let held = rosterOf(database, "linear");
  expect(held.listedAt == "t2");
  expect(held.tools.indexOf("new_name") >= 0);
  expect(held.tools.indexOf("old_name") < 0);
});

test("one connector's roster is not another's, and forgetting takes only one", () => {
  fresh();
  let a: McpTool[] = [];
  a.push(tool("linear_tool", ""));
  let b: McpTool[] = [];
  b.push(tool("notion_tool", ""));
  rememberRoster(database, "linear", a, "t1");
  rememberRoster(database, "notion", b, "t1");

  forgetRoster(database, "linear");
  expect(rosterOf(database, "linear").listedAt == "");
  expect(rosterOf(database, "notion").tools.indexOf("notion_tool") >= 0);
});

test("the switches are filled in fresh, not remembered", () => {
  fresh();
  let tools: McpTool[] = [];
  tools.push(tool("create_issue", "File an issue"));
  tools.push(tool("delete_issue", "Remove one"));
  rememberRoster(database, "linear", tools, "t1");

  let off: string[] = [];
  off.push("delete_issue");
  let shown = rosterWithSwitches(rosterOf(database, "linear").tools, off);
  expect(shown.indexOf("{\"name\":\"create_issue\",\"description\":\"File an issue\",\"on\":true}") >= 0);
  expect(shown.indexOf("\"delete_issue\",\"description\":\"Remove one\",\"on\":false") >= 0);
});

test("a connector with an absurd number of tools is bounded", () => {
  fresh();
  let tools: McpTool[] = [];
  let i: int = 0;
  while (i < MAX_REMEMBERED_TOOLS + 40) {
    tools.push(tool("tool_" + `${i}`, ""));
    i = i + 1;
  }
  rememberRoster(database, "big", tools, "t1");
  let held = rosterOf(database, "big");
  expect(held.tools.indexOf("\"tool_0\"") >= 0);
  expect(held.tools.indexOf("\"tool_" + `${MAX_REMEMBERED_TOOLS + 10}` + "\"") < 0);
});
