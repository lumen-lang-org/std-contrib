import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../../plume/plume.ts";
import { migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { masterKey, masterKeyProblem, storeCredential } from "../credentials.ts";
import { AgentRun, runAgent } from "../run.ts";

function main(): void {
  let master = masterKey();
  if (masterKeyProblem(master) != "") {
    console.error(masterKeyProblem(master));
    return;
  }

  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_run.db" };
  connectDatabase(db, cfg);
  forgetMigrations(db);
  execute(db, "DROP TABLE IF EXISTS agent_sub_agents"); execute(db, "DROP TABLE IF EXISTS agent_mcp_servers");
  dropTable(db, credentialsMapping()); dropTable(db, agentsMapping()); dropTable(db, mcpServersMapping());
  dropTable(db, promptsMapping()); dropTable(db, modelConfigsMapping(db)); dropTable(db, modelsMapping());
  migrate(db, schemaPlan(db));

  let small: ModelRow = { id: "m1", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  persist(db, modelsMapping(), JSON.stringify(small));
  let conf: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.0, maxTokens: 32, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(db, modelConfigsMapping(db), JSON.stringify(conf));
  let terse: PromptRow = { id: "p1", promptName: "terse", version: 1, body: "Answer with a single number and nothing else.", createdAt: "2026-07-25" };
  let chatty: PromptRow = { id: "p2", promptName: "terse", version: 2, body: "Answer in one short sentence.", createdAt: "2026-07-25" };
  persist(db, promptsMapping(), JSON.stringify(terse));
  persist(db, promptsMapping(), JSON.stringify(chatty));
  let calc: AgentRow = { id: "a1", agentName: "calculator", description: "does sums", modelConfigId: "c1", promptId: "p1", enabled: true, isDefault: false, scriptImageId: "", updatedAt: "2026-07-25" };
  persist(db, agentsMapping(), JSON.stringify(calc));

  let fromEnv = process.env("MISTRAL_API_KEY") ?? "";
  if (fromEnv != "") {
    storeCredential(db, { provider: "mistral", apiKey: fromEnv, masterKey: master, now: "2026-07-25" });
  }

  let first = runAgent(db, "a1", "What is 2 plus 40?", master);
  console.log("agent=" + first.agentName + " prompt=v" + `${first.promptVersion}` + " model=" + first.modelApiName);
  console.log("ok=" + `${first.ok}` + " status=" + `${first.status}` + " " + first.error);
  if (first.text != "") {
    console.log("reply " + first.text);
  }

  execute(db, "UPDATE agents SET prompt_id = 'p2' WHERE id = 'a1'");
  let second = runAgent(db, "a1", "What is 2 plus 40?", master);
  console.log("");
  console.log("after UPDATE: prompt=v" + `${second.promptVersion}` + " ok=" + `${second.ok}`);
  if (second.text != "") {
    console.log("reply " + second.text);
  }

  execute(db, "UPDATE agents SET enabled = 0 WHERE id = 'a1'");
  console.log("disabled -> " + runAgent(db, "a1", "hi", master).error);
}
main();
