// The agent verbs without a model: naming, the prompt-version rule, and the
// sentences. Versions never edit — the roll-back is the point.
//
//   cd packages/agents && lumen test agent-tools.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, createTable, dropTable, persist } from "../plume/plume.ts";
import { AgentRow, ModelConfigRow, ModelRow, PromptRow, agentsMapping, modelConfigsMapping, modelsMapping, promptsMapping } from "./schema.ts";
import { AgentToolCall, agentTools, callAgentTool } from "./agent-tools.ts";

let database: Db = sqlite();
let ready = false;
const NOW: number = 1786124262180.0;

function db(): Db {
  if (!ready) {
    let cfg: DbConfig = { filename: "/tmp/agents_agent_tools_test.db" };
    connectDatabase(database, cfg);
    // The four tables these verbs touch, built directly: a full schemaPlan
    // against a file that remembers half its tables aborts mid-plan, and
    // this suite needs exactly these.
    dropTable(database, agentsMapping());
    dropTable(database, promptsMapping());
    dropTable(database, modelConfigsMapping(database));
    dropTable(database, modelsMapping());
    createTable(database, agentsMapping());
    createTable(database, promptsMapping());
    createTable(database, modelConfigsMapping(database));
    createTable(database, modelsMapping());
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
  let p: PromptRow = { id: "p1", promptName: "helper", version: 1, body: "You help.", createdAt: "1" };
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

test("four names answer, and show carries the whole prompt", () => {
  expect(agentTools().length == 4);
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
  // A twin is refused with the way forward named.
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
  expect(idle.text.includes("description, prompt, model_config or enabled"));
  let guest = call("guest:x", "list_agents", "{}");
  expect(!guest.ok);
});
