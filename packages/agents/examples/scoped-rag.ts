// Retrieval in the run path, scoped by folder.
//
//   export LUMEN_MASTER_KEY=... MISTRAL_API_KEY=...
//   cd packages/agents && lumen run examples/scoped-rag.ts
//
// PostgreSQL, because pgvector has no SQLite equivalent. Two agents share one
// embedding model and one documents table, and each reads only the folder it
// was granted — which is the point: the isolation is a property of the rows,
// not of having separate corpora.

import { Db, DbConfig } from "../../plume/driver.ts";
import { postgres } from "../../plume/postgres.ts";
import { connectDatabase, persist, execute, executeWith, dropTable } from "../../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { storeCredential, credentialFor, masterKey } from "../credentials.ts";
import { AgentRetrievalRow, embeddingModel, createDocuments, uploadDocument, agentRetrievalMapping, knowledgePlan, grantScope, agentScopes, scopeCounts, retrievalFor } from "../knowledge.ts";
import { AgentRun, runAgent } from "../run.ts";

function main(): void {
  let master = masterKey();
  let apiKey = process.env("MISTRAL_API_KEY") ?? "";
  if (master == "" || apiKey == "") {
    console.log("set LUMEN_MASTER_KEY and MISTRAL_API_KEY.");
    return;
  }

  let db = postgres();
  let cfg: DbConfig = { host: "127.0.0.1", user: "lumen", password: "lumen", database: "lumenvec" };
  connectDatabase(db, cfg);

  forgetMigrations(db);
  execute(db, "DROP TABLE IF EXISTS agent_scopes");
  execute(db, "DROP TABLE IF EXISTS agent_retrieval");
  execute(db, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(db, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(db, "DROP INDEX IF EXISTS prompts_by_name");
  execute(db, "DROP INDEX IF EXISTS scopes_by_agent");
  execute(db, "DROP TABLE IF EXISTS documents");
  dropTable(db, credentialsMapping()); dropTable(db, agentsMapping());
  dropTable(db, mcpServersMapping()); dropTable(db, promptsMapping());
  dropTable(db, modelConfigsMapping(db)); dropTable(db, modelsMapping());

  let plan = schemaPlan(db);
  let extra = knowledgePlan(db);
  let e: int = 0;
  while (e < extra.length) { plan.push(extra[e]); e = e + 1; }
  let ran = migrate(db, plan);
  if (!ran.ok) { console.log("migrate: " + ran.error); return; }

  // --- the models -----------------------------------------------------------

  let chat: ModelRow = { id: "m1", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, enabled: true };
  let embed: ModelRow = { id: "e1", label: "Mistral Embed", apiName: "mistral-embed", provider: "mistral", kind: "embedding", dimensions: 1024, enabled: true };
  persist(db, modelsMapping(), JSON.stringify(chat));
  persist(db, modelsMapping(), JSON.stringify(embed));
  let config: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.0, maxTokens: 400, topP: 1.0, extra: "{}" };
  persist(db, modelConfigsMapping(db), JSON.stringify(config));
  let prompt: PromptRow = { id: "p1", promptName: "librarian", version: 1, createdAt: "2026-07-26", body: "Answer only from the passages you are given. If they do not say, reply that your documents do not cover it. Two sentences at most." };
  persist(db, promptsMapping(), JSON.stringify(prompt));
  storeCredential(db, { provider: "mistral", apiKey: apiKey, masterKey: master, now: "2026-07-26" });

  let embedder = embeddingModel(db, "e1");
  let made = createDocuments(db, embedder);
  if (made != "") { console.log("documents: " + made); return; }

  // --- two folders ----------------------------------------------------------

  let stored = credentialFor(db, "mistral", master);
  let engineering = uploadDocument(db, embedder, "plume_relations", "/engineering/plume",
    "A plume relation is a correlated subquery, not a join. An agent with three servers and two sub-agents is still one row, because each relation produces its own JSON that the database nests.\n\n"
    + "MySQL's JSON_ARRAYAGG does not preserve the order of what it aggregates, so plume does not aggregate in SQL: a subquery's ORDER BY is honoured for which rows come back and ignored for the order they sit in.", stored);
  console.log("uploaded  /engineering/plume  chunks=" + `${engineering.chunks}` + " " + engineering.error);

  let hr = uploadDocument(db, embedder, "leave_policy", "/hr/policies",
    "Annual leave is 28 days including public holidays. Carry-over is capped at five days and expires on 31 March.\n\n"
    + "Sick leave beyond three consecutive days requires a note. There is no cap on paid sick leave in the first year.", stored);
  console.log("uploaded  /hr/policies       chunks=" + `${hr.chunks}` + " " + hr.error);

  console.log("");
  console.log("-- the folder tree ---------------------------------------------");
  let tree = scopeCounts(db, "");
  let n: int = 0;
  while (n < tree.length) {
    console.log("  " + tree[n].path + "   documents " + `${tree[n].documents}` + ", total " + `${tree[n].total}`);
    n = n + 1;
  }

  // --- two agents, one corpus, different grants -----------------------------

  let engineer: AgentRow = { id: "eng", agentName: "engineer", description: "reads engineering docs", modelConfigId: "c1", promptId: "p1", enabled: true, updatedAt: "2026-07-26" };
  let people: AgentRow = { id: "hr", agentName: "people", description: "reads HR policies", modelConfigId: "c1", promptId: "p1", enabled: true, updatedAt: "2026-07-26" };
  persist(db, agentsMapping(), JSON.stringify(engineer));
  persist(db, agentsMapping(), JSON.stringify(people));

  grantScope(db, "eng", "/engineering");
  grantScope(db, "hr", "/hr");

  let engRetrieval: AgentRetrievalRow = { agentId: "eng", embeddingModelId: "e1", topK: 3, maxDistance: 1.0, enabled: true };
  let hrRetrieval: AgentRetrievalRow = { agentId: "hr", embeddingModelId: "e1", topK: 3, maxDistance: 1.0, enabled: true };
  persist(db, agentRetrievalMapping(), JSON.stringify(engRetrieval));
  persist(db, agentRetrievalMapping(), JSON.stringify(hrRetrieval));

  console.log("");
  console.log("engineer granted " + agentScopes(db, "eng").join(", "));
  console.log("people   granted " + agentScopes(db, "hr").join(", "));

  // --- the questions --------------------------------------------------------

  ask(db, master, "eng", "How many days of annual leave do we get?");
  ask(db, master, "hr", "How many days of annual leave do we get?");
  ask(db, master, "eng", "Why does plume not aggregate relations in SQL?");

  db.close();
}

// One question, with what the run retrieved to answer it.
function ask(db: Db, master: string, agentId: string, question: string): void {
  console.log("");
  console.log("-- " + agentId + ": " + question);
  let run = runAgent(db, agentId, question, master);
  let i: int = 0;
  while (i < run.retrieved.length) {
    console.log("   read  " + run.retrieved[i].scope + "/" + run.retrieved[i].source
      + "  distance " + `${run.retrieved[i].distance}`);
    i = i + 1;
  }
  let n: int = 0;
  while (n < run.notes.length) { console.log("   note  " + run.notes[n]); n = n + 1; }
  console.log("   said  " + run.text);
}

main();
