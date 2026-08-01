// Calling a model whose name came out of the database.
//
//   MISTRAL_API_KEY=... lumen run examples/call-model.ts
//
// Without a key the call is refused before a request is made. Adding a
// provider is an INSERT; disabling a model is an UPDATE.

import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, findById, execute, dropTable } from "../../plume/plume.ts";
import { migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, schemaPlan } from "../schema.ts";
import { Completion, complete, chatEndpoint } from "../provider.ts";

// model_configs declares a hasOne("model") relation, so its document carries a
// nested model. A record type must name every key the document has.
// Every key the document has, and not one fewer: JSON.parse<T> refuses an
// UnknownField, so a view that omits a column the row now carries fails at
// run time with "invalid JSON" and nothing pointing at which column. kind,
// dimensions and baseUrl arrived after this example was written, and that is
// exactly how it broke.
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

  // Mistral is a row. Adding a provider is an INSERT.
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

  // Disabling the model stops the call without touching this program.
  execute(db, "UPDATE models SET enabled = 0 WHERE id = 'm3'");
  let raw = findById(db, modelsMapping(), "m3");
  console.log("row       " + raw);
  let off: ModelRow = JSON.parse<ModelRow>(raw);
  console.log("disabled  " + complete(off, config, "", "hi", key).error);
}
main();
