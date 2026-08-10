import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../../plume/plume.ts";
import { migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, McpServerRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { storeCredential, masterKey } from "../credentials.ts";
import { AgentRun, runAgent } from "../run.ts";
import { mountTools } from "../tools.ts";

function main(): void {
  let master = masterKey();
  if (master == "") {
    console.log("set LUMEN_MASTER_KEY first: a credential is stored encrypted, and the key is not.");
    return;
  }
  let apiKey = process.env("MISTRAL_API_KEY") ?? "";
  if (apiKey == "") {
    console.log("set MISTRAL_API_KEY: it is written to the database encrypted and not kept anywhere else.");
    return;
  }

  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_tools_demo.db" };
  connectDatabase(db, cfg);
  forgetMigrations(db);
  execute(db, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(db, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(db, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(db, credentialsMapping()); dropTable(db, agentsMapping());
  dropTable(db, mcpServersMapping()); dropTable(db, promptsMapping());
  dropTable(db, modelConfigsMapping(db)); dropTable(db, modelsMapping());
  migrate(db, schemaPlan(db));

  let model: ModelRow = {
    id: "m1",
    label: "Mistral Small",
    apiName: "mistral-small-latest",
    provider: "mistral",
    kind: "chat",
    dimensions: 0,
    baseUrl: "",
    enabled: true,
  };
  persist(db, modelsMapping(), JSON.stringify(model));

  let config: ModelConfigRow = {
    id: "c1",
    modelId: "m1",
    temperature: 0.0,
    maxTokens: 400,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(db, modelConfigsMapping(db), JSON.stringify(config));

  let prompt: PromptRow = {
    id: "p1",
    promptName: "parts-desk",
    version: 1,
    createdAt: "2026-07-25",
    body: "You answer questions about parts and stock. Use the tools for anything about stock levels or prices; never guess a number.",
  };
  persist(db, promptsMapping(), JSON.stringify(prompt));

  let server: McpServerRow = {
    id: "s1",
    serverName: "parts",
    transport: "http",
    endpoint: "http://127.0.0.1:8200",
    authKind: "none",
    authHeader: "",
    enabled: true,
  };
  persist(db, mcpServersMapping(), JSON.stringify(server));

  let agent: AgentRow = {
    id: "a1",
    agentName: "parts-desk",
    description: "answers stock questions",
    modelConfigId: "c1",
    promptId: "p1",
    enabled: true,
    isDefault: false,
    scriptImageId: "",
    updatedAt: "2026-07-25",
  };
  persist(db, agentsMapping(), JSON.stringify(agent));

  execute(db, "INSERT INTO agent_mcp_servers VALUES ('a1','s1')");

  storeCredential(db, {
    provider: "mistral",
    apiKey: apiKey,
    masterKey: master,
    now: "2026-07-25",
  });

  let mounted = mountTools(db, "a1", master);
  console.log("mounted   " + `${mounted.tools.length}` + " tools from " + `${mounted.servers.length}` + " server(s)");
  let t: int = 0;
  while (t < mounted.tools.length) {
    console.log("  - " + mounted.tools[t].name + ": " + mounted.tools[t].description);
    t = t + 1;
  }
  let p: int = 0;
  while (p < mounted.faults.length) {
    console.log("  ! " + mounted.faults[p]);
    p = p + 1;
  }

  let question = "We need 40 units of A-114. Is there enough in Rotterdam, and what would 40 cost?";
  console.log("");
  console.log("user      " + question);

  let run = runAgent(db, "a1", question, master);

  console.log("");
  console.log("-- what the model did (context) --------------------------------");
  let i: int = 0;
  while (i < run.steps.length) {
    let step = run.steps[i];
    let mark = "ok ";
    if (!step.ok) {
      mark = "err";
    }
    console.log(`${step.index}` + " " + mark + " " + step.server + "." + step.tool + " " + step.args);
    console.log("      -> " + step.result);
    i = i + 1;
  }
  console.log("rounds    " + `${run.rounds}` + ", stopped: " + run.stopReason);

  console.log("");
  console.log("-- what the user sees (conversation) ---------------------------");
  console.log("agent     " + run.text);
  if (!run.ok) {
    console.log("error     " + run.error);
  }

  db.close();
}

main();
