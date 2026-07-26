// The same agent, two prompt versions, one question — and the trace as the
// evidence of which is better.
//
//   cd packages/agents && lumen run examples/prompt-ab.ts
//
// The lead was observed asking its sub-agent twice: once for stock and price,
// then again to ask whether it could ship — a question the first answer had
// already settled. Nothing about that is a defect; it is what the prompt asked
// for. So this changes the prompt, which is a row, and re-runs.
//
// Between the two runs the only write is an INSERT of a prompt version and an
// UPDATE of one column. No file changes, nothing restarts, and the previous
// version is still there to roll back to.

import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { connectDatabase, persist, execute, executeWith, dropTable, findById } from "../../plume/plume.ts";
import { Migration, migrate, forgetMigrations } from "../../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, McpServerRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "../schema.ts";
import { storeCredential, masterKey } from "../credentials.ts";
import { AgentRun, AgentStep, runAgentTraced } from "../run.ts";
import { TraceConfigRow, traceConfigMapping, tracePlan, tracerFor } from "../trace.ts";
import { flush, traceId, tracing, tracerWithMoreSpans } from "../../tracing/tracing.ts";
import { jsonText } from "../scan.ts";

const QUESTION = "Can we ship 40 units of A-114 from Rotterdam today, and what is the bill?";

// v1: what was running when the lead asked twice.
const LEAD_V1 = "You are a purchasing lead. You have no data of your own: for anything about stock or prices, ask the parts desk agent and use what it tells you. Answer in one short paragraph.";

// v2: the same instruction, plus the one thing v1 never said. The desk cannot
// see this conversation, so a question has to carry its own context — and an
// answer already given is not worth asking for again.
const LEAD_V2 = "You are a purchasing lead. You have no data of your own: for anything about stock or prices, ask the parts desk agent. Ask ONCE, in a single question carrying everything you need — the part, the warehouse, the quantity — and then reason from the answer yourself. Do not ask again for something you have already been told; if the desk says 37 units are in stock, you already know 40 cannot ship. Answer in one short paragraph.";

function run(db: Db, master: string, label: string): void {
  let tracer = tracerFor(db, master);
  let out = runAgentTraced(db, "a1", QUESTION, master, tracer);

  console.log("");
  console.log("=== " + label + " ==========================================");
  console.log("trace     " + traceId(tracer));
  let delegations: int = 0;
  let i: int = 0;
  while (i < out.steps.length) {
    let step = out.steps[i];
    if (step.tool.startsWith("ask_")) {
      delegations = delegations + 1;
      console.log("  ask " + `${delegations}` + ": " + jsonText(step.args, "question"));
    } else {
      console.log("  tool : " + step.server + "." + step.tool);
    }
    i = i + 1;
  }
  console.log("rounds    " + `${out.rounds}` + "  delegations " + `${delegations}` + "  spans " + `${out.spans.length}`);
  console.log("answer    " + out.text);

  let sent = flush(tracerWithMoreSpans(tracer, out.spans));
  if (!sent.ok) { console.log("flush     " + sent.error); }
}

function main(): void {
  let master = masterKey();
  let apiKey = process.env("MISTRAL_API_KEY") ?? "";
  let collector = process.env("OTLP_ENDPOINT") ?? "http://localhost:3000/api/public/otel/v1/traces";
  if (master == "" || apiKey == "") {
    console.log("set LUMEN_MASTER_KEY and MISTRAL_API_KEY.");
    return;
  }

  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/agents_ab_demo.db" };
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

  let v1: PromptRow = { id: "lead-v1", promptName: "lead", version: 1, createdAt: "2026-07-26", body: LEAD_V1 };
  persist(db, promptsMapping(), JSON.stringify(v1));
  let deskPrompt: PromptRow = { id: "p2", promptName: "parts-desk", version: 1, createdAt: "2026-07-26", body: "You answer questions about parts and stock using the tools. Never guess a number." };
  persist(db, promptsMapping(), JSON.stringify(deskPrompt));

  let server: McpServerRow = { id: "s1", serverName: "parts", transport: "http", endpoint: "http://127.0.0.1:8200", enabled: true };
  persist(db, mcpServersMapping(), JSON.stringify(server));

  let lead: AgentRow = { id: "a1", agentName: "lead", description: "purchasing lead", modelConfigId: "c1", promptId: "lead-v1", enabled: true, updatedAt: "2026-07-26" };
  let desk: AgentRow = { id: "a2", agentName: "parts-desk", description: "knows stock levels and prices for every part", modelConfigId: "c1", promptId: "p2", enabled: true, updatedAt: "2026-07-26" };
  persist(db, agentsMapping(), JSON.stringify(lead));
  persist(db, agentsMapping(), JSON.stringify(desk));
  execute(db, "INSERT INTO agent_mcp_servers VALUES ('a2','s1')");
  execute(db, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
  storeCredential(db, { provider: "mistral", apiKey: apiKey, masterKey: master, now: "2026-07-26" });

  let traceRow: TraceConfigRow = {
    id: "default", backend: "langfuse", endpoint: collector,
    publicKey: process.env("LANGFUSE_PUBLIC_KEY") ?? "pk-lf-lumen-demo",
    serviceName: "lumen-agents", environment: "prompt-ab", enabled: true,
  };
  persist(db, traceConfigMapping(), JSON.stringify(traceRow));
  storeCredential(db, { provider: "tracing", apiKey: process.env("LANGFUSE_SECRET_KEY") ?? "sk-lf-lumen-demo", masterKey: master, now: "2026-07-26" });

  console.log("question  " + QUESTION);
  run(db, master, "prompt v1 (ask and use what it tells you)");

  // The whole change: a new version, and one column repointed.
  let v2: PromptRow = { id: "lead-v2", promptName: "lead", version: 2, createdAt: "2026-07-26", body: LEAD_V2 };
  persist(db, promptsMapping(), JSON.stringify(v2));
  executeWith(db, "UPDATE agents SET prompt_id = " + db.placeholder + " WHERE id = 'a1'", ["lead-v2"]);

  run(db, master, "prompt v2 (ask once, reason from the answer)");

  console.log("");
  console.log("v1 is still a row: rolling back is UPDATE agents SET prompt_id = 'lead-v1'.");
  db.close();
}

main();
