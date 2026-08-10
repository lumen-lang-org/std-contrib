import { Db, DbConfig } from "../../plume/driver.ts";
import { postgres } from "../../plume/postgres.ts";
import { connectDatabase, persist, execute, dropTable } from "../../plume/plume.ts";
import { migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { masterKey, masterKeyProblem, storeCredential, credentialFor } from "../credentials.ts";
import { Embedding, embedText } from "../provider.ts";
import { Retrieved, Retrieval, embeddingModel, createDocuments, indexDocument, retrieve, asContext } from "../knowledge.ts";
import { AgentRun, runAgent } from "../run.ts";


function main(): void {
  let master = masterKey();
  if (masterKeyProblem(master) != "") { console.error(masterKeyProblem(master)); return; }

  let db = postgres();
  let cfg: DbConfig = { host: "127.0.0.1", user: "lumen", password: "lumen", database: "lumenvec" };
  connectDatabase(db, cfg);
  forgetMigrations(db);
  execute(db, "DROP TABLE IF EXISTS documents");
  execute(db, "DROP TABLE IF EXISTS agent_sub_agents"); execute(db, "DROP TABLE IF EXISTS agent_mcp_servers");
  dropTable(db, credentialsMapping()); dropTable(db, agentsMapping()); dropTable(db, mcpServersMapping());
  dropTable(db, promptsMapping()); dropTable(db, modelConfigsMapping(db)); dropTable(db, modelsMapping());
  migrate(db, schemaPlan(db));

  let key = process.env("MISTRAL_API_KEY") ?? "";
  if (key != "") { storeCredential(db, { provider: "mistral", apiKey: key, masterKey: master, now: "2026-07-25" }); }
  let stored = credentialFor(db, "mistral", master);

  let embedRow: ModelRow = { id: "e1", label: "Mistral Embed", apiName: "mistral-embed", provider: "mistral", kind: "embedding", dimensions: 1024, baseUrl: "", enabled: true };
  persist(db, modelsMapping(), JSON.stringify(embedRow));

  let embedder = embeddingModel(db, "e1");
  if (embedder.id == "") { console.error("no embedding model e1"); return; }
  console.log("embedding with " + embedder.label + " at " + `${embedder.dimensions}` + " dimensions");
  let problem = createDocuments(db, embedder);
  if (problem != "") { console.error(problem); return; }

  indexDocument(db, embedder, { id: "d1", source: "plume", scope: "/specs/plume", body: "The plume package maps records to tables. A mapping is stated once with the field, column and SQL type; nothing is inferred from a name." }, stored);
  indexDocument(db, embedder, { id: "d2", source: "plume", scope: "/specs/plume", body: "A page without an ordering is refused by pageOrdered, because two requests for the first twenty rows can overlap or skip records when the database answers in any order." }, stored);
  indexDocument(db, embedder, { id: "d3", source: "rest", scope: "/specs/rest", body: "The rest package refuses to listen when a route names a handler nothing bound, so a missing handler is a startup failure naming the route rather than a 500 a user finds." }, stored);
  console.log("indexed 3 documents");

  let question = "Why does plume refuse an unordered page?";
  let granted: string[] = ["/specs"];
  let found = retrieve(db, embedder, granted, question, 2, stored);
  if (!found.ok) { console.error(found.error); return; }
  console.log("");
  let i: int = 0;
  while (i < found.found.length) {
    console.log("retrieved " + found.found[i].source + "/" + found.found[i].id
      + "  distance " + `${found.found[i].distance}`);
    i = i + 1;
  }

  let chat: ModelRow = { id: "m1", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, baseUrl: "", enabled: true };
  persist(db, modelsMapping(), JSON.stringify(chat));
  let conf: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.0, maxTokens: 120, topP: 1.0, extra: "{}", thinking: "", label: "", selectable: false, rank: 0 };
  persist(db, modelConfigsMapping(db), JSON.stringify(conf));
  let grounded: PromptRow = { id: "p1", promptName: "grounded", version: 1, body: "Answer from the context only, in one sentence.", createdAt: "2026-07-25" };
  persist(db, promptsMapping(), JSON.stringify(grounded));
  let librarian: AgentRow = { id: "a1", agentName: "librarian", description: "answers from the corpus", modelConfigId: "c1", promptId: "p1", enabled: true, isDefault: false, scriptImageId: "", updatedAt: "2026-07-25" };
  persist(db, agentsMapping(), JSON.stringify(librarian));

  let answered = runAgent(db, "a1", asContext(found.found) + "\nQuestion: " + question, master);
  console.log("");
  console.log("agent=" + answered.agentName + " model=" + answered.modelApiName + " ok=" + `${answered.ok}` + " " + answered.error);
  console.log("");
  console.log(answered.text);
}
main();
