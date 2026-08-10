import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, findById, execute, dropTable, listWhere } from "../../plume/plume.ts";
import { migrate, forgetMigrations } from "../../plume/migrate.ts";
import { McpServerRow, mcpServersMapping, agentsMapping, modelsMapping, modelConfigsMapping, promptsMapping, schemaPlan } from "../schema.ts";
import { McpCall, initialize, toolNames, callTool } from "../mcp.ts";

function main(): void {
  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_mcp.db" };
  connectDatabase(db, cfg);
  forgetMigrations(db);
  execute(db, "DROP TABLE IF EXISTS agent_sub_agents"); execute(db, "DROP TABLE IF EXISTS agent_mcp_servers");
  dropTable(db, agentsMapping()); dropTable(db, mcpServersMapping()); dropTable(db, promptsMapping());
  dropTable(db, modelConfigsMapping(db)); dropTable(db, modelsMapping());
  migrate(db, schemaPlan(db));

  let demo: McpServerRow = { id: "s1", serverName: "demo-mcp", transport: "http", endpoint: "http://127.0.0.1:8200", authKind: "none", authHeader: "", enabled: true };
  persist(db, mcpServersMapping(), JSON.stringify(demo));

  let mounted: McpServerRow = JSON.parse<McpServerRow>(findById(db, mcpServersMapping(), "s1"));
  console.log("mounting  " + mounted.serverName + " at " + mounted.endpoint);

  let hello = initialize(mounted, "");
  console.log("initialize ok=" + `${hello.ok}` + " " + hello.error);

  let tools = toolNames(mounted, "");
  console.log("tools     " + tools.join(", "));

  let sum = callTool(mounted, "add", "{\"a\":2,\"b\":40}", "");
  console.log("add(2,40) " + sum.text + " " + sum.error);

  let echoed = callTool(mounted, "echo", "{\"text\":\"from the database\"}", "");
  console.log("echo      " + echoed.text);

  let missing = callTool(mounted, "nope", "{}", "");
  console.log("nope      ok=" + `${missing.ok}` + " " + missing.error);

  execute(db, "UPDATE mcp_servers SET enabled = 0 WHERE id = 's1'");
  let off: McpServerRow = JSON.parse<McpServerRow>(findById(db, mcpServersMapping(), "s1"));
  console.log("disabled  ok=" + `${initialize(off, "").ok}` + " " + initialize(off, "").error);
}
main();
