// The delegation run, traced.
//
//   python3 mcpserver.py 8200 &
//   python3 otlp.py 8300 &                 # or point at Langfuse
//   export LUMEN_MASTER_KEY=... MISTRAL_API_KEY=...
//   cd packages/agents && lumen run examples/delegate-traced.ts
//
// Same two agents as delegate.ts. What is added is a trace_config row and a
// secret in the credential store — tracing is off until both exist, and this
// writes them the way the API would.

import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, McpServerRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { storeCredential, masterKey } from "../credentials.ts";
import { AgentRun, runAgentTraced } from "../run.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "../trace.ts";
import { flush, traceId, spanCount, tracing, tracerWithMoreSpans, traceBody } from "../../tracing/tracing.ts";

function main(): void {
  let master = masterKey();
  let apiKey = process.env("MISTRAL_API_KEY") ?? "";
  let collector = process.env("OTLP_ENDPOINT") ?? "http://127.0.0.1:8300/api/public/otel/v1/traces";
  if (master == "" || apiKey == "") {
    console.log("set LUMEN_MASTER_KEY and MISTRAL_API_KEY.");
    return;
  }

  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_traced_demo.db" };
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

  let leadPrompt: PromptRow = { id: "p1", promptName: "lead", version: 1, createdAt: "2026-07-26", body: "You are a purchasing lead. You have no data of your own: for anything about stock or prices, ask the parts desk agent and use what it tells you. Answer in one short paragraph." };
  persist(db, promptsMapping(), JSON.stringify(leadPrompt));
  let deskPrompt: PromptRow = { id: "p2", promptName: "parts-desk", version: 1, createdAt: "2026-07-26", body: "You answer questions about parts and stock using the tools. Never guess a number." };
  persist(db, promptsMapping(), JSON.stringify(deskPrompt));

  let server: McpServerRow = { id: "s1", serverName: "parts", transport: "http", endpoint: "http://127.0.0.1:8200", enabled: true };
  persist(db, mcpServersMapping(), JSON.stringify(server));

  let lead: AgentRow = { id: "a1", agentName: "lead", description: "purchasing lead", modelConfigId: "c1", promptId: "p1", enabled: true, updatedAt: "2026-07-26" };
  let desk: AgentRow = { id: "a2", agentName: "parts-desk", description: "knows stock levels and prices for every part", modelConfigId: "c1", promptId: "p2", enabled: true, updatedAt: "2026-07-26" };
  persist(db, agentsMapping(), JSON.stringify(lead));
  persist(db, agentsMapping(), JSON.stringify(desk));
  execute(db, "INSERT INTO agent_mcp_servers VALUES ('a2','s1')");
  execute(db, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");

  storeCredential(db, "mistral", apiKey, master, "2026-07-26");

  // --- tracing on, by two rows ----------------------------------------------

  let traceRow: TraceConfigRow = {
    id: "default",
    backend: process.env("TRACE_BACKEND") ?? "langfuse",
    endpoint: collector,
    publicKey: process.env("LANGFUSE_PUBLIC_KEY") ?? "pk-lf-demo",
    serviceName: "lumen-agents",
    environment: "demo",
    enabled: true,
  };
  persist(db, traceConfigMapping(), JSON.stringify(traceRow));
  storeCredential(db, "tracing", process.env("LANGFUSE_SECRET_KEY") ?? "sk-lf-demo", master, "2026-07-26");

  let tracer = tracerFor(db, master);
  console.log("tracing   " + `${tracing(tracer)}` + " -> " + collector);
  console.log("trace id  " + traceId(tracer));
  console.log("");

  let question = "Can we ship 40 units of A-114 from Rotterdam today, and what is the bill?";
  console.log("user      " + question);

  let run = runAgentTraced(db, "a1", question, master, tracer);

  console.log("");
  console.log("lead      " + run.text);
  console.log("");
  console.log("spans     " + `${run.spans.length}` + " recorded");

  let sent = flush(tracerWithMoreSpans(tracer, run.spans));
  console.log("flush     ok=" + `${sent.ok}` + " status=" + `${sent.status}` + " " + sent.error);

  db.close();
}

main();
