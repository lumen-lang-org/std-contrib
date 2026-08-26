import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, dropTable, execute, persist } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { AgentRow, ModelConfigRow, ModelRow, PromptRow, agentsMapping, modelConfigsMapping, modelsMapping, promptsMapping, schemaPlan, skillsMapping, skillFilesMapping } from "./schema.ts";
import { agentRetrievalMapping, knowledgePlan } from "./knowledge.ts";
import { AgentToolCall, agentTools, callAgentTool } from "./agent-tools.ts";

let database: Db = sqlite();
let ready = false;
const NOW: number = 1786124262180.0;

function db(): Db {
  if (!ready) {
    let cfg: DbConfig = { filename: "/tmp/agents_agent_tools_test.db" };
    connectDatabase(database, cfg);
    forgetMigrations(database);
    execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
    execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
    execute(database, "DROP TABLE IF EXISTS agent_skills");
    execute(database, "DROP TABLE IF EXISTS agent_scopes");
    execute(database, "DROP INDEX IF EXISTS prompts_by_name");
    dropTable(database, skillFilesMapping());
    dropTable(database, skillsMapping());
    dropTable(database, agentRetrievalMapping());
    dropTable(database, agentsMapping());
    dropTable(database, promptsMapping());
    dropTable(database, modelConfigsMapping(database));
    dropTable(database, modelsMapping());
    let plan = schemaPlan(database);
    let extra = knowledgePlan(database);
    let e: int = 0;
    while (e < extra.length) {
      plan.push(extra[e]);
      e = e + 1;
    }
    migrate(database, plan);
    seed();
    ready = true;
  }
  return database;
}

function seed(): void {
  let m: ModelRow = { id: "m1", label: "Flash", apiName: "flash", provider: "deepseek",
    kind: "chat", dimensions: 0, baseUrl: "", enabled: true, contextTokens: 0 };
  persist(database, modelsMapping(), JSON.stringify(m));
  let c: ModelConfigRow = { id: "c1", modelId: "m1", temperature: 0.5, maxTokens: 800,
    topP: 1.0, extra: "", thinking: "", label: "DeepSeek Flash", selectable: true, rank: 1 };
  persist(database, modelConfigsMapping(database), JSON.stringify(c));
  let p: PromptRow = {
    id: "p1",
    promptName: "helper",
    version: 1,
    body: "You help.",
    createdAt: "1",
  };
  persist(database, promptsMapping(), JSON.stringify(p));
  let a: AgentRow = { id: "a1", agentName: "helper", description: "helps",
    modelConfigId: "c1", promptId: "p1", enabled: true, isDefault: true,
    scriptImageId: "", updatedAt: "1" };
  persist(database, agentsMapping(), JSON.stringify(a));
}

type Said = { handled: bool, ok: bool, text: string };

function call(owner: string, name: string, args: string): Said {
  let asked: AgentToolCall = { owner: owner, name: name, args: args, nowMs: NOW };
  let got = callAgentTool(db(), asked);
  let out: Said = { handled: got.handled, ok: got.ok, text: got.text };
  return out;
}

test("six names answer, and show carries the whole prompt", () => {
  expect(agentTools().length == 6);
  expect(!call("o1", "schedule_task", "{}").handled);
  let shown = call("o1", "show_agent", "{\"agent\":\"helper\"}");
  expect(shown.ok);
  expect(shown.text.includes("You help."));
  expect(shown.text.includes("v1"));
  expect(shown.text.includes("DeepSeek Flash"));
});

test("a created agent is born on the default config with prompt v1", () => {
  let made = call("o1", "create_agent",
    "{\"name\":\"french-tutor\",\"description\":\"answers in French\",\"prompt\":\"Reponds toujours en francais, simplement.\"}");
  expect(made.ok);
  expect(made.text.includes("french-tutor"));
  expect(made.text.includes("v1"));
  expect(made.text.includes("DeepSeek Flash"));
  let twin = call("o1", "create_agent", "{\"name\":\"french-tutor\",\"prompt\":\"x\"}");
  expect(!twin.ok);
  expect(twin.text.includes("change_agent"));
});

test("a changed prompt is a new version, and the old one is said to remain", () => {
  let changed = call("o1", "change_agent",
    "{\"agent\":\"french-tutor\",\"prompt\":\"Reponds en francais. Sois bref.\"}");
  expect(changed.ok);
  expect(changed.text.includes("v2"));
  expect(changed.text.includes("v1 stays"));
  let shown = call("o1", "show_agent", "{\"agent\":\"french-tutor\"}");
  expect(shown.text.includes("Sois bref"));
});

test("nothing sent, nothing changed — and it says what could be", () => {
  let idle = call("o1", "change_agent", "{\"agent\":\"helper\"}");
  expect(!idle.ok);
  expect(idle.text.includes("add_skill or prompt_version"));
  let guest = call("guest:x", "list_agents", "{}");
  expect(!guest.ok);
});

test("rollback repoints, delete refuses the default and takes the rest", () => {
  let v2 = call("o1", "change_agent", "{\"agent\":\"helper\",\"prompt\":\"You help, tersely.\"}");
  expect(v2.ok);
  let back = call("o1", "change_agent", "{\"agent\":\"helper\",\"prompt_version\":1}");
  expect(back.ok);
  expect(back.text.includes("rolled to v1"));
  let shown = call("o1", "show_agent", "{\"agent\":\"helper\"}");
  expect(shown.text.includes("You help."));
  expect(!shown.text.includes("tersely"));

  let refused = call("o1", "delete_agent", "{\"agent\":\"helper\"}");
  expect(!refused.ok);
  expect(refused.text.includes("default"));

  database.query("SELECT id FROM agents WHERE agent_name = 'french-tutor'", []);
  let tutorId = database.value(0, 0);
  execute(database, "INSERT INTO agent_scopes (agent_id, scope) VALUES ('" + tutorId + "', '/french')");
  execute(database, "INSERT INTO agent_sub_agents (parent_id, child_id) VALUES ('a1', '" + tutorId + "')");

  let bye = call("o1", "delete_agent", "{\"agent\":\"french-tutor\"}");
  expect(bye.ok);
  expect(call("o1", "show_agent", "{\"agent\":\"french-tutor\"}").ok == false);

  database.query("SELECT COUNT(*) FROM agent_scopes WHERE agent_id = '" + tutorId + "'", []);
  expect(database.value(0, 0) == "0");
  database.query("SELECT COUNT(*) FROM agent_sub_agents WHERE child_id = '" + tutorId + "'", []);
  expect(database.value(0, 0) == "0");
});

test("ask_agent refuses an empty message before it reaches the agent lookup", () => {
  let asked = call("o1", "ask_agent", "{\"agent\":\"helper\",\"message\":\"\"}");
  expect(!asked.ok);
  expect(asked.text.includes("what to ask"));
});

test("ask_agent refuses same as show_agent when nothing by that name exists", () => {
  let missing = call("o1", "ask_agent", "{\"agent\":\"nobody\",\"message\":\"hi\"}");
  expect(!missing.ok);
  expect(missing.text.includes("no agent"));
});

test("ask_agent reaches the provider boundary: agent, prompt and model config both resolve", () => {
  let asked = call("o1", "ask_agent", "{\"agent\":\"helper\",\"message\":\"hi there\"}");
  expect(!asked.ok);
  expect(asked.text.includes("credential") || asked.text.includes("LUMEN_MASTER_KEY"));
});
