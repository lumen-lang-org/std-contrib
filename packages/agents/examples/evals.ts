// Running a Langfuse dataset against the agent tree.
//
//   python3 mcpserver.py 8200 &
//   docker compose up -d          # a Langfuse with a dataset in it
//   export LUMEN_MASTER_KEY=... MISTRAL_API_KEY=...
//   cd packages/agents && lumen run examples/evals.ts
//
// The cases come out of Langfuse, the answers come from the lead agent (which
// delegates to the parts desk, which calls MCP tools), and the judge is itself
// an agent — so what judges, and how strictly, is a row.

import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, McpServerRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { storeCredential, masterKey } from "../credentials.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "../trace.ts";
import { EvalRun, runEvals } from "../evals.ts";

function main(): void {
  let master = masterKey();
  let apiKey = process.env("MISTRAL_API_KEY") ?? "";
  let collector = process.env("OTLP_ENDPOINT") ?? "http://localhost:3000/api/public/otel/v1/traces";
  let dataset = process.env("EVAL_DATASET") ?? "parts-desk-evals";
  let runName = process.env("EVAL_RUN") ?? "manual";
  if (master == "" || apiKey == "") {
    console.log("set LUMEN_MASTER_KEY and MISTRAL_API_KEY.");
    return;
  }

  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_evals_demo.db" };
  connectDatabase(db, cfg);
  forgetMigrations(db);
  execute(db, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(db, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(db, "DROP INDEX IF EXISTS prompts_by_name");
  execute(db, "DROP TABLE IF EXISTS trace_config");
  dropTable(db, credentialsMapping()); dropTable(db, agentsMapping());
  dropTable(db, mcpServersMapping()); dropTable(db, promptsMapping());
  dropTable(db, modelConfigsMapping(db)); dropTable(db, modelsMapping());

  let plan = schemaPlan(db);
  let extra = tracePlan(db);
  let e: int = 0;
  while (e < extra.length) { plan.push(extra[e]); e = e + 1; }
  migrate(db, plan);

  let model: ModelRow = { id: "m1", label: "Mistral Small", apiName: "mistral-small-latest", provider: "mistral", kind: "chat", dimensions: 0, enabled: true };
  persist(db, modelsMapping(), JSON.stringify(model));
  let config: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.0, maxTokens: 500, topP: 1.0, extra: "{}" };
  persist(db, modelConfigsMapping(db), JSON.stringify(config));

  let leadPrompt: PromptRow = { id: "p1", promptName: "lead", version: 2, createdAt: "2026-07-26", body: "You are a purchasing lead. You have no data of your own: for anything about stock or prices, ask the parts desk agent. Ask ONCE, in a single question carrying everything you need — the part, the warehouse, the quantity — and then reason from the answer yourself. Answer in one short paragraph." };
  persist(db, promptsMapping(), JSON.stringify(leadPrompt));
  let deskPrompt: PromptRow = { id: "p2", promptName: "parts-desk", version: 1, createdAt: "2026-07-26", body: "You answer questions about parts and stock using the tools. Never guess a number." };
  persist(db, promptsMapping(), JSON.stringify(deskPrompt));

  // The judge is an agent: its model and its strictness are rows, and swapping
  // it is an UPDATE rather than an edit to the eval code.
  let judgePrompt: PromptRow = { id: "p3", promptName: "judge", version: 1, createdAt: "2026-07-26", body: "You grade answers. You are given a question, a reference answer and an answer to grade. Reply with JSON only and nothing else: {\"score\": <0 to 1>, \"reason\": \"<one sentence>\"}. Score 1 when the facts and numbers match the reference, 0 when they contradict it, and in between when something asked for is missing." };
  persist(db, promptsMapping(), JSON.stringify(judgePrompt));

  let server: McpServerRow = { id: "s1", serverName: "parts", transport: "http", endpoint: "http://127.0.0.1:8200", enabled: true };
  persist(db, mcpServersMapping(), JSON.stringify(server));

  let lead: AgentRow = { id: "a1", agentName: "lead", description: "purchasing lead", modelConfigId: "c1", promptId: "p1", enabled: true, updatedAt: "2026-07-26" };
  let desk: AgentRow = { id: "a2", agentName: "parts-desk", description: "knows stock levels and prices for every part", modelConfigId: "c1", promptId: "p2", enabled: true, updatedAt: "2026-07-26" };
  let judge: AgentRow = { id: "judge1", agentName: "judge", description: "grades answers", modelConfigId: "c1", promptId: "p3", enabled: true, updatedAt: "2026-07-26" };
  persist(db, agentsMapping(), JSON.stringify(lead));
  persist(db, agentsMapping(), JSON.stringify(desk));
  persist(db, agentsMapping(), JSON.stringify(judge));
  execute(db, "INSERT INTO agent_mcp_servers VALUES ('a2','s1')");
  execute(db, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
  storeCredential(db, "mistral", apiKey, master, "2026-07-26");

  let traceRow: TraceConfigRow = {
    id: "default", backend: "langfuse", endpoint: collector,
    publicKey: process.env("LANGFUSE_PUBLIC_KEY") ?? "pk-lf-lumen-demo",
    serviceName: "lumen-agents", environment: "evals", enabled: true,
  };
  persist(db, traceConfigMapping(), JSON.stringify(traceRow));
  storeCredential(db, "tracing", process.env("LANGFUSE_SECRET_KEY") ?? "sk-lf-lumen-demo", master, "2026-07-26");

  console.log("dataset   " + dataset);
  console.log("run       " + runName);
  console.log("");

  let out = runEvals(db, "a1", "judge1", dataset, runName, tracerFor(db, master), master, 50);
  if (!out.ok) {
    console.log("refused   " + out.error);
    db.close();
    return;
  }

  let i: int = 0;
  while (i < out.results.length) {
    let r = out.results[i];
    let mark = "PASS";
    if (!r.ran) { mark = "FAIL"; } else if (r.score < 0.7) { mark = "POOR"; }
    console.log(mark + "  answer " + `${r.score}` + "  tools " + `${r.toolScore}` + "  agents " + `${r.agentScore}` + "   " + r.question);
    console.log("      answered: " + r.answer.slice(0, 90));
    if (r.reason != "") { console.log("      judge   : " + r.reason); }
    console.log("      route   : tools [" + r.calledTools.join(", ") + "]  agents [" + r.calledAgents.join(", ") + "]");
    if (r.missingTools.length > 0) { console.log("      MISSING tools : " + r.missingTools.join(", ")); }
    if (r.missingAgents.length > 0) { console.log("      MISSING agents: " + r.missingAgents.join(", ")); }
    if (r.error != "") { console.log("      error   : " + r.error); }
    console.log("      trace   : " + r.traceId + "  (" + `${r.delegations}` + " delegations, " + `${r.rounds}` + " rounds)");
    i = i + 1;
  }

  console.log("");
  console.log("passed    " + `${out.passed}` + "/" + `${out.items}` + "   mean score " + `${out.meanScore}`);
  db.close();
}

main();
