// The scoped corpus, evaluated.
//
//   export LUMEN_MASTER_KEY=... MISTRAL_API_KEY=...
//   cd packages/agents && EVAL_AGENT=eng lumen run examples/rag-evals.ts
//   cd packages/agents && EVAL_AGENT=hr  lumen run examples/rag-evals.ts
//
// One dataset spanning both folders, run against each agent in turn. Neither
// should pass all of it: an agent granted /hr can answer the leave questions
// and not the engineering ones, and the reverse. A suite that scored either
// agent 4/4 would mean the scopes were not holding.
//
// This is what evaluating retrieval is for. The answers alone cannot tell you
// whether a wrong one came from a bad model, an empty folder or a grant that
// does not cover what was asked -- `retrieval` scores which folder the passages
// actually came off.

import { Db, DbConfig } from "../../plume/driver.ts";
import { postgres } from "../../plume/postgres.ts";
import { connectDatabase, persist, execute, executeWith, dropTable } from "../../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { storeCredential, credentialFor, masterKey } from "../credentials.ts";
import { AgentRetrievalRow, embeddingModel, createDocuments, uploadDocument, agentRetrievalMapping, knowledgePlan, grantScope, agentScopes, scopeCounts, retrievalFor } from "../knowledge.ts";
import { AgentRun, runAgent } from "../run.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "../trace.ts";
import { EvalRun, runEvals } from "../evals.ts";

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
  execute(db, "DROP TABLE IF EXISTS trace_config");
  dropTable(db, credentialsMapping()); dropTable(db, agentsMapping());
  dropTable(db, mcpServersMapping()); dropTable(db, promptsMapping());
  dropTable(db, modelConfigsMapping(db)); dropTable(db, modelsMapping());

  let plan = schemaPlan(db);
  let extra = knowledgePlan(db);
  let e: int = 0;
  while (e < extra.length) { plan.push(extra[e]); e = e + 1; }
  let traces = tracePlan(db);
  let t: int = 0;
  while (t < traces.length) { plan.push(traces[t]); t = t + 1; }
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

  // --- the judge, and where the cases live ----------------------------------

  let judgePrompt: PromptRow = { id: "pj", promptName: "judge", version: 1, createdAt: "2026-07-26", body: "You grade answers. You are given a question, a reference answer and an answer to grade. Reply with JSON only: {\"score\": <0 to 1>, \"reason\": \"<one sentence>\"}. Score 1 when the facts match the reference, 0 when they contradict it or the answer declines to say. An answer that admits it does not know is 0 against a reference that states a fact." };
  persist(db, promptsMapping(), JSON.stringify(judgePrompt));
  let judge: AgentRow = { id: "judge", agentName: "judge", description: "grades answers", modelConfigId: "c1", promptId: "pj", enabled: true, updatedAt: "2026-07-26" };
  persist(db, agentsMapping(), JSON.stringify(judge));

  let traceRow: TraceConfigRow = {
    id: "default", backend: "langfuse",
    endpoint: process.env("OTLP_ENDPOINT") ?? "http://localhost:3000/api/public/otel/v1/traces",
    publicKey: process.env("LANGFUSE_PUBLIC_KEY") ?? "pk-lf-lumen-demo",
    serviceName: "lumen-agents", environment: "rag-evals", enabled: true,
  };
  persist(db, traceConfigMapping(), JSON.stringify(traceRow));
  storeCredential(db, { provider: "tracing", apiKey: process.env("LANGFUSE_SECRET_KEY") ?? "sk-lf-lumen-demo", masterKey: master, now: "2026-07-26" });

  // --- the run ---------------------------------------------------------------

  let agentId = process.env("EVAL_AGENT") ?? "eng";
  let dataset = process.env("EVAL_DATASET") ?? "scoped-rag";
  let runName = process.env("EVAL_RUN") ?? ("rag-" + agentId);

  console.log("");
  console.log("-- " + dataset + " against " + agentId + " ------------------------------");
  let out = runEvals(db, {
  agentId: agentId,
  judgeAgentId: "judge",
  dataset: dataset,
  runName: runName,
  master: master,
  maxItems: 50,
}, tracerFor(db, master));
  if (!out.ok) { console.log("refused   " + out.error); db.close(); return; }

  let i: int = 0;
  while (i < out.results.length) {
    let r = out.results[i];
    let mark = "PASS";
    if (!r.ran) { mark = "FAIL"; } else if (r.score < 0.7) { mark = "MISS"; }
    console.log(mark + "  answer " + `${r.score}` + "  retrieval " + `${r.scopeScore}` + "   " + r.question);
    console.log("      read      " + r.usedScopes.join(", "));
    if (r.missingScopes.length > 0) { console.log("      NOT read  " + r.missingScopes.join(", ")); }
    console.log("      said      " + r.answer.slice(0, 88));
    i = i + 1;
  }
  console.log("");
  console.log("passed    " + `${out.passed}` + "/" + `${out.items}` + "   mean " + `${out.meanScore}`);

  db.close();
}


main();
