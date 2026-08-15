import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ModelRow, ModelConfigRow, PromptRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping, schemaPlan } from "./schema.ts";
import { storeCredential } from "./credentials.ts";
import { AgentRun, runAgent } from "./run.ts";
import { replyText } from "./provider.ts";

let database: Db = sqlite();

function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

function seeded(): void {
  let file = "/tmp/agents_run_test.db";
  // Rebuilt from an empty file: the plan ALTERs tables this fixture does
  // not drop, so re-running it over a leftover database stops partway
  // and the suite then tests a schema production never has.
  if (fs.existsSync(file)) {
    fs.rmSync(file, false);
  }
  let cfg: DbConfig = { filename: file };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  execute(database, "DROP TABLE IF EXISTS script_images");
  execute(database, "DROP TABLE IF EXISTS thread_summaries");
  execute(database, "DROP TABLE IF EXISTS plugins");
  execute(database, "DROP TABLE IF EXISTS plugin_items");
  migrate(database, schemaPlan(database));

  let m: ModelRow = {
    id: "m1",
    label: "Mistral Small",
    apiName: "mistral-small-latest",
    provider: "mistral",
    kind: "chat",
    dimensions: 0,
    baseUrl: "",
    enabled: true,
    contextTokens: 0,
  };
  persist(database, modelsMapping(), JSON.stringify(m));
  let c: ModelConfigRow = {
    id: "c1",
    modelId: "m1",
    temperature: 0.0,
    maxTokens: 32,
    topP: 1.0,
    extra: "{}",
    thinking: "",
    label: "",
    selectable: false,
    rank: 0,
  };
  persist(database, modelConfigsMapping(database), JSON.stringify(c));
  let p: PromptRow = {
    id: "p1",
    promptName: "terse",
    version: 3,
    body: "Be brief.",
    createdAt: "t",
  };
  persist(database, promptsMapping(), JSON.stringify(p));
  let a: AgentRow = {
    id: "a1",
    agentName: "calculator",
    description: "d",
    modelConfigId: "c1",
    promptId: "p1",
    scriptImageId: "",
    isDefault: false,
    enabled: true,
    updatedAt: "t",
  };
  persist(database, agentsMapping(), JSON.stringify(a));
}

test("an agent that does not exist is named, not guessed at", () => {
  seeded();
  let r = runAgent(database, "nope", "hi", testKey());
  expect(!r.ok);
  expect(r.error.indexOf("no agent nope") >= 0);
});

test("a disabled agent does not call a provider", () => {
  seeded();
  execute(database, "UPDATE agents SET enabled = 0 WHERE id = 'a1'");
  let r = runAgent(database, "a1", "hi", testKey());
  expect(!r.ok);
  expect(r.error.indexOf("disabled") >= 0);
  expect(r.agentName == "calculator");
  expect(r.status == 0);
});

test("without a credential nothing is sent", () => {
  seeded();
  let r = runAgent(database, "a1", "hi", testKey());
  expect(!r.ok);
  expect(r.error.indexOf("no usable credential") >= 0);
  expect(r.error.indexOf("mistral") >= 0);
  expect(r.status == 0);
});

test("a config pointing at nothing is reported", () => {
  seeded();
  execute(database, "UPDATE agents SET model_config_id = 'gone' WHERE id = 'a1'");
  let r = runAgent(database, "a1", "hi", testKey());
  expect(!r.ok);
  expect(r.error.indexOf("no model config gone") >= 0);
});

test("a disabled model stops the call, even with a credential", () => {
  seeded();
  storeCredential(database, {
    provider: "mistral",
    apiKey: "sk-fake-0001",
    masterKey: testKey(),
    now: "t",
  });
  execute(database, "UPDATE models SET enabled = 0 WHERE id = 'm1'");
  let r = runAgent(database, "a1", "hi", testKey());
  expect(!r.ok);
  expect(r.error.indexOf("disabled") >= 0);
});

test("the run reports which prompt version and model answered", () => {
  seeded();
  let r = runAgent(database, "a1", "hi", testKey());
  expect(r.agentName == "calculator");
});

test("no refusal carries the master key or a credential", () => {
  seeded();
  storeCredential(database, {
    provider: "mistral",
    apiKey: "sk-should-never-appear",
    masterKey: testKey(),
    now: "t",
  });
  execute(database, "UPDATE models SET enabled = 0 WHERE id = 'm1'");
  let r = runAgent(database, "a1", "hi", testKey());
  expect(r.error.indexOf("sk-should-never-appear") < 0);
  expect(r.error.indexOf(testKey()) < 0);
  expect(r.body.indexOf("sk-should-never-appear") < 0);
});

test("the assistant's text is pulled out of a provider's reply", () => {
  let mistral = "{\"usage\":{\"total_tokens\":9},\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"42\"}}]}";
  expect(replyText("mistral", mistral) == "42");
  let anthropic = "{\"content\":[{\"type\":\"text\",\"text\":\"42\"}]}";
  expect(replyText("anthropic", anthropic) == "42");
});

test("escapes in the reply are unescaped", () => {
  let withNewline = "{\"choices\":[{\"message\":{\"content\":\"one\\ntwo\"}}]}";
  let got = replyText("mistral", withNewline);
  expect(got.indexOf("one") >= 0);
  expect(got.indexOf("two") >= 0);
  expect(got.indexOf("\\n") < 0);

  let withQuote = "{\"choices\":[{\"message\":{\"content\":\"say \\\"hi\\\"\"}}]}";
  expect(replyText("mistral", withQuote) == "say \"hi\"");
});

test("a reply in an unknown shape is handed back whole rather than guessed at", () => {
  expect(replyText("mistral", "{\"unexpected\":true}") == "{\"unexpected\":true}");
});

test("the suite leaves nothing behind", () => {
  seeded();
  expect(dropTable(database, agentsMapping()).ok);
  database.close();
});
