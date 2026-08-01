// A provider call whose key was read from the database and decrypted on the
// way out.
//
//   LUMEN_MASTER_KEY=$(head -c 32 /dev/urandom | base64 | head -c 32) \
//   MISTRAL_API_KEY=... lumen run examples/stored-credential.ts
//
// The key is stored once, encrypted with a master key that lives only in the
// environment. Every later run reads the ciphertext out of the table.

import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, findById, execute, dropTable } from "../../plume/plume.ts";
import { migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, CredentialRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { masterKey, masterKeyProblem, storeCredential, credentialFor, providersWithCredentials } from "../credentials.ts";
import { Completion, complete } from "../provider.ts";

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
  let master = masterKey();
  let problem = masterKeyProblem(master);
  if (problem != "") { console.error(problem); return; }

  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_stored.db" };
  connectDatabase(db, cfg);
  forgetMigrations(db);
  execute(db, "DROP TABLE IF EXISTS agent_sub_agents"); execute(db, "DROP TABLE IF EXISTS agent_mcp_servers");
  dropTable(db, credentialsMapping()); dropTable(db, agentsMapping()); dropTable(db, mcpServersMapping());
  dropTable(db, promptsMapping()); dropTable(db, modelConfigsMapping(db)); dropTable(db, modelsMapping());
  migrate(db, schemaPlan(db));

  let small: ModelRow = { id: "m3", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  persist(db, modelsMapping(), JSON.stringify(small));
  let conf: ModelConfigRow = { id: "c3", modelId: "m3", temperature: 0.3, maxTokens: 32, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(db, modelConfigsMapping(db), JSON.stringify(conf));

  // Stored once, from the environment. A real deployment does this through the
  // API and never again.
  let fromEnv = process.env("MISTRAL_API_KEY") ?? "";
  if (fromEnv != "") {
    let stored = storeCredential(db, { provider: "mistral", apiKey: fromEnv, masterKey: master, now: "2026-07-25" });
    if (stored != "") { console.error(stored); return; }
  }
  console.log("stored for " + providersWithCredentials(db).join(", "));

  // What the table actually holds.
  let row: CredentialRow = JSON.parse<CredentialRow>(findById(db, credentialsMapping(), "cred-mistral"));
  console.log("envelope    " + row.envelope.substring(0, 44) + "…");
  console.log("plaintext in the row? " + `${row.envelope.indexOf(fromEnv.substring(0, 8)) >= 0}`);

  let model: ModelRow = JSON.parse<ModelRow>(findById(db, modelsMapping(), "m3"));
  let view: ConfigView = JSON.parse<ConfigView>(findById(db, modelConfigsMapping(db), "c3"));
  let config: ModelConfigRow = { id: view.id, modelId: view.modelId, temperature: view.temperature, maxTokens: view.maxTokens, topP: view.topP, extra: view.extra, thinking: view.thinking, label: view.label, selectable: view.selectable, rank: view.rank };

  // The key never leaves this line as plaintext anywhere it could be logged.
  let answer = complete(model, config, "Answer in one word.", "What is 2+40?", credentialFor(db, "mistral", master));
  console.log("call        ok=" + `${answer.ok}` + " status=" + `${answer.status}` + " " + answer.error);

  // With the wrong master key there is no key to send, and the call is refused
  // before a request is made.
  let wrong = complete(model, config, "", "hi", credentialFor(db, "mistral", "fedcba9876543210fedcba9876543210"));
  console.log("wrong master ok=" + `${wrong.ok}` + " " + wrong.error);
}
main();
