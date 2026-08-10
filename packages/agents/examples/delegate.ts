import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../../plume/plume.ts";
import { migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, McpServerRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { storeCredential, masterKey } from "../credentials.ts";
import { AgentRun, runAgent } from "../run.ts";

function main(): void {
  let master = masterKey();
  let apiKey = process.env("MISTRAL_API_KEY") ?? "";
  if (master == "" || apiKey == "") {
    console.log("set LUMEN_MASTER_KEY and MISTRAL_API_KEY.");
    return;
  }

  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_delegate_demo.db" };
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
    maxTokens: 500,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(db, modelConfigsMapping(db), JSON.stringify(config));

  let leadPrompt: PromptRow = {
    id: "p1",
    promptName: "lead",
    version: 1,
    createdAt: "2026-07-25",
    body: "You are a purchasing lead. You have no data of your own: for anything about stock or prices, ask the parts desk agent and use what it tells you. Answer in one short paragraph.",
  };
  persist(db, promptsMapping(), JSON.stringify(leadPrompt));
  let deskPrompt: PromptRow = {
    id: "p2",
    promptName: "parts-desk",
    version: 1,
    createdAt: "2026-07-25",
    body: "You answer questions about parts and stock using the tools. Never guess a number.",
  };
  persist(db, promptsMapping(), JSON.stringify(deskPrompt));

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

  let lead: AgentRow = {
    id: "a1",
    agentName: "lead",
    description: "purchasing lead",
    modelConfigId: "c1",
    promptId: "p1",
    enabled: true,
    isDefault: false,
    scriptImageId: "",
    updatedAt: "2026-07-25",
  };
  let desk: AgentRow = {
    id: "a2",
    agentName: "parts-desk",
    description: "knows stock levels and prices for every part",
    modelConfigId: "c1",
    promptId: "p2",
    enabled: true,
    isDefault: false,
    scriptImageId: "",
    updatedAt: "2026-07-25",
  };
  persist(db, agentsMapping(), JSON.stringify(lead));
  persist(db, agentsMapping(), JSON.stringify(desk));

  execute(db, "INSERT INTO agent_mcp_servers VALUES ('a2','s1')");
  execute(db, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");

  storeCredential(db, {
    provider: "mistral",
    apiKey: apiKey,
    masterKey: master,
    now: "2026-07-25",
  });

  let question = "Can we ship 40 units of A-114 from Rotterdam today, and what is the bill?";
  console.log("user      " + question);
  console.log("");

  let run = runAgent(db, "a1", question, master);

  console.log("-- what the lead did ------------------------------------------");
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
  let n: int = 0;
  while (n < run.notes.length) {
    console.log("  ! " + run.notes[n]);
    n = n + 1;
  }
  console.log("rounds    " + `${run.rounds}` + ", stopped: " + run.stopReason);

  console.log("");
  console.log("-- what the user sees -----------------------------------------");
  console.log("lead      " + run.text);
  if (!run.ok) {
    console.log("error     " + run.error);
  }

  db.close();
}

main();
