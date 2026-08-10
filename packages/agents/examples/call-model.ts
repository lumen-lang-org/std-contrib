import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, findById, execute, dropTable } from "../../plume/plume.ts";
import { migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, schemaPlan } from "../schema.ts";
import { Completion, complete, chatEndpoint } from "../provider.ts";

type ModelView = { id: string, label: string, apiName: string, provider: string, kind: string, dimensions: int, baseUrl: string, enabled: bool };
type ConfigView = {
  id: string, modelId: string, temperature: number, maxTokens: int, topP: number, extra: string,
  thinking: string, label: string, selectable: bool, rank: int,
  model: ModelView,
};

function main(): void {
  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_mistral.db" };
  connectDatabase(db, cfg);
  forgetMigrations(db);
  execute(db, "DROP TABLE IF EXISTS agent_sub_agents"); execute(db, "DROP TABLE IF EXISTS agent_mcp_servers");
  dropTable(db, agentsMapping()); dropTable(db, mcpServersMapping()); dropTable(db, promptsMapping());
  dropTable(db, modelConfigsMapping(db)); dropTable(db, modelsMapping());
  migrate(db, schemaPlan(db));

  let small: ModelRow = { id: "m3", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  persist(db, modelsMapping(), JSON.stringify(small));
  let conf: ModelConfigRow = { id: "c3", modelId: "m3", temperature: 0.3, maxTokens: 64, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(db, modelConfigsMapping(db), JSON.stringify(conf));

  console.log("raw model  [" + findById(db, modelsMapping(), "m3") + "]");
  console.log("raw config [" + findById(db, modelConfigsMapping(db), "c3") + "]");
  let model: ModelRow = JSON.parse<ModelRow>(findById(db, modelsMapping(), "m3"));
  let view: ConfigView = JSON.parse<ConfigView>(findById(db, modelConfigsMapping(db), "c3"));
  let config: ModelConfigRow = { id: view.id, modelId: view.modelId, temperature: view.temperature, maxTokens: view.maxTokens, topP: view.topP, extra: view.extra, thinking: view.thinking, label: view.label, selectable: view.selectable, rank: view.rank };
  console.log("model     " + model.label + " -> " + model.apiName + " @ " + chatEndpoint(model.provider));

  let key = process.env("MISTRAL_API_KEY") ?? "";
  let answer = complete(model, config, "Answer in one word.", "What is 2+40?", key);
  console.log("ok=" + `${answer.ok}` + " status=" + `${answer.status}` + " " + answer.error);
  if (answer.text != "") { console.log("body      " + answer.text.substring(0, 160)); }

  execute(db, "UPDATE models SET enabled = 0 WHERE id = 'm3'");
  let raw = findById(db, modelsMapping(), "m3");
  console.log("row       " + raw);
  let off: ModelRow = JSON.parse<ModelRow>(raw);
  console.log("disabled  " + complete(off, config, "", "hi", key).error);
}
main();
