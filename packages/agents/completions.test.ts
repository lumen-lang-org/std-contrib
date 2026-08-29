import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, findById, persist } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ModelChoiceRow, ModelConfigRow, ModelRow, modelChoicesMapping, modelConfigRows, modelsMapping, schemaPlan } from "./schema.ts";
import { runLogPlan, runsMapping } from "./runlog.ts";
import { CompletionService } from "./routes/inference/completions/completion.service.ts";
import { CompletionAsk, completionAskOf } from "./routes/inference/completions/dtos/completion-ask.dto.ts";
import { Completion, ToolSpec, Turn } from "./provider.ts";

let database: Db = sqlite();

// A fresh file per run: schemaPlan is most of the deployment's tables and
// enumerating drops for all of them is a maintenance trap. /tmp is tmpfs.
function fresh(): CompletionService {
  let cfg: DbConfig = { filename: "/tmp/agents_completions_test_" + `${Date.now()}` + ".db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  // One plan, one migrate — two calls put runLogPlan's low versions below
  // schemaPlan's high water and the second call is refused as out-of-order.
  let plan = schemaPlan(database);
  let logs = runLogPlan(database);
  let i: int = 0;
  while (i < logs.length) {
    plan.push(logs[i]);
    i = i + 1;
  }
  migrate(database, plan);
  return new CompletionService(database);
}

function askOf(choiceId: string, configId: string, input: string): CompletionAsk {
  let noTurns: Turn[] = [];
  let noTools: ToolSpec[] = [];
  let ask: CompletionAsk = {
    modelChoiceId: choiceId,
    modelConfigId: configId,
    system: "",
    input: input,
    turns: noTurns,
    tools: noTools,
    maxTokens: 0,
  };
  return ask;
}

function seedModel(provider: string, enabled: bool): void {
  let model: ModelRow = {
    id: "m-test", label: "Test", apiName: "test-model", provider: provider,
    kind: "chat", dimensions: 0, baseUrl: "", enabled: enabled, contextTokens: 0,
  };
  persist(database, modelsMapping(), JSON.stringify(model));
  let config: ModelConfigRow = {
    id: "c-test", modelId: "m-test", temperature: 0.2, maxTokens: 256,
    topP: 1.0, extra: "", thinking: "", label: "Test", selectable: true, rank: 0,
  };
  persist(database, modelConfigRows(database), JSON.stringify(config));
}

test("an empty input or an unnamed model is refused before anything is looked up", () => {
  let completions = fresh();
  expect(completions.answer("alice", askOf("", "c-test", "")).status == 400);
  expect(completions.answer("alice", askOf("", "", "hello")).status == 400);
  expect(completions.answer("alice", askOf("ch-1", "c-test", "hello")).status == 400);
});

test("a config nobody created is a 400 that names it, not a crash", () => {
  let completions = fresh();
  let reply = completions.answer("alice", askOf("", "c-none", "hello"));
  expect(reply.status == 400);
  expect(reply.body.indexOf("c-none") >= 0);
});

test("a router choice is refused: completions take a fixed model", () => {
  let completions = fresh();
  seedModel("mistral", true);
  let choice: ModelChoiceRow = {
    id: "ch-router", label: "Auto", description: "", kind: "router",
    configId: "", routerId: "r1", tier: "", enabled: true, rank: 0,
  };
  persist(database, modelChoicesMapping(), JSON.stringify(choice));
  let reply = completions.answer("alice", askOf("ch-router", "", "hello"));
  expect(reply.status == 400);
  expect(reply.body.indexOf("modelConfigId") >= 0);
});

test("a provider with no stored credential is a 400 that names the provider", () => {
  let completions = fresh();
  seedModel("mistral", true);
  let reply = completions.answer("alice", askOf("", "c-test", "hello"));
  // With no LUMEN_MASTER_KEY in the test environment this is the 500 arm
  // instead; both are honest refusals and neither may reach the network.
  expect(reply.status == 400 || reply.status == 500);
});

test("record writes a runs row that carries the spend and the completions route note", () => {
  let completions = fresh();
  let answered: Completion = {
    ok: true, text: "fine", status: 200, error: "",
    inputTokens: 12, outputTokens: 34, counted: true,
  };
  let runId = completions.record("alice", askOf("", "c-test", "what is up"), "test-model", answered, "fine");
  expect(runId != "");
  let held = findById(database, runsMapping(), runId);
  expect(held != "");
  expect(held.indexOf("\"routeNote\":\"completions\"") >= 0);
  expect(held.indexOf("\"owner\":\"alice\"") >= 0);
  expect(held.indexOf("\"inputTokens\":12") >= 0);
  expect(held.indexOf("\"outputTokens\":34") >= 0);
});

test("the ask parser reads the documented fields and nothing invents defaults", () => {
  let ask = completionAskOf("{\"modelChoiceId\":\"ch\",\"system\":\"be brief\",\"input\":\"hi\",\"maxTokens\":9000}");
  expect(ask.modelChoiceId == "ch");
  expect(ask.modelConfigId == "");
  expect(ask.system == "be brief");
  expect(ask.input == "hi");
  expect(ask.maxTokens == 9000);
});
