import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { schemaPlan } from "./schema.ts";
import { jsonRaw, jsonText } from "./scan.ts";
import { storeCredential } from "./credentials.ts";
import { ModelAsk } from "./routes/inference/models/dtos/model-ask.dto.ts";
import { ModelRegistered } from "./routes/inference/models/dtos/model-registered.dto.ts";
import { ModelRegistration } from "./routes/inference/models/dtos/model-registration.dto.ts";
import { ModelService } from "./routes/inference/models/model.service.ts";
import { ModelConfigService } from "./routes/inference/model-configs/model-config.service.ts";
import { ModelChoiceBody } from "./routes/inference/model-choices/dtos/model-choice-body.dto.ts";
import { ModelChoiceService } from "./routes/inference/model-choices/model-choice.service.ts";

let database: Db = sqlite();

function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

/* A file rebuilt from empty each time: the plan ALTERs tables, so re-running it
   over a leftover database stops partway and the suite then tests a schema
   production never has. */
function fresh(): void {
  let file = "/tmp/agents_model_register_test.db";
  if (fs.existsSync(file)) {
    fs.rmSync(file, false);
  }
  let cfg: DbConfig = { filename: file };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  migrate(database, schemaPlan(database));
}

function models(): ModelService {
  return new ModelService(database, testKey());
}

function asked(kind: string, baseUrl: string, maxTokens: int): ModelRegistration {
  // An embedding model without dimensions is refused, and rightly: nothing can
  // store its vectors without knowing how wide they are.
  let dimensions = 0;
  if (kind == "embedding") {
    dimensions = 768;
  }
  return new ModelRegistration("Local Qwen", "qwen3-4b", "vllm", kind,
    dimensions, baseUrl, 32768, 0.0, maxTokens, 0.0, "off");
}

test("one call leaves a model, a config, and the choice a workflow binds", () => {
  fresh();
  let made = models().register(asked("chat", "http://127.0.0.1:8090/v1", 4096));
  expect(made.fault == "");

  let out: ModelRegistered = JSON.parse<ModelRegistered>(made.document);
  expect(out.modelId != "");
  expect(out.modelConfigId != "");
  expect(out.modelChoiceId != "");

  // The choice is the point: a workflow binds modelChoiceId, and a
  // registration that stopped at the config would leave a model that answers
  // over /completions and is offered nowhere.
  let choice: ModelChoiceBody = JSON.parse<ModelChoiceBody>(
    new ModelChoiceService(database).one(out.modelChoiceId));
  expect(choice.kind == "config");
  expect(choice.configId == out.modelConfigId);
  expect(choice.enabled);

  let config = new ModelConfigService(database).one(out.modelConfigId);
  expect(jsonText(config, "modelId") == out.modelId);
});

test("knobs left at zero take a working default, never zero", () => {
  fresh();
  let made = models().register(asked("chat", "http://127.0.0.1:8090/v1", 0));
  expect(made.fault == "");
  let out: ModelRegistered = JSON.parse<ModelRegistered>(made.document);
  let config = new ModelConfigService(database).one(out.modelConfigId);

  // A maxTokens of 0 is a model that returns nothing, which reads as a broken
  // model rather than a bad setting.
  expect(jsonRaw(config, "maxTokens") != "0");
  expect(jsonRaw(config, "maxTokens") != "");
  expect(jsonRaw(config, "temperature") != "0");
  expect(jsonRaw(config, "topP") != "0");
});

test("an embedding model gets no config and no choice, because it is not chosen from a menu", () => {
  fresh();
  let made = models().register(asked("embedding", "http://127.0.0.1:8000/v1", 0));
  expect(made.fault == "");
  let out: ModelRegistered = JSON.parse<ModelRegistered>(made.document);
  expect(out.modelId != "");
  expect(out.modelConfigId == "");
  expect(out.modelChoiceId == "");
});

test("a new model may reuse an address the provider already sends to", () => {
  fresh();
  let first = models().create(new ModelAsk("m-first", "First", "qwen3-4b",
    "vllm", "chat", 0, "http://127.0.0.1:8090/v1", true, 32768));
  expect(first.fault == "");
  storeCredential(database, {
    provider: "vllm", apiKey: "local-no-auth", masterKey: testKey(), now: "t",
  });

  // Before this was allowed, registering any second model at an endpoint the
  // key already talks to was refused outright - and a baseUrl is exactly what
  // a local endpoint needs, so every local model hit it.
  let made = models().register(asked("chat", "http://127.0.0.1:8090/v1", 4096));
  expect(made.fault == "");
});

test("an address the provider has never sent to is still refused while a key is stored", () => {
  fresh();
  let first = models().create(new ModelAsk("m-first", "First", "qwen3-4b",
    "vllm", "chat", 0, "http://127.0.0.1:8090/v1", true, 32768));
  expect(first.fault == "");
  storeCredential(database, {
    provider: "vllm", apiKey: "local-no-auth", masterKey: testKey(), now: "t",
  });

  // The guard still earns its place: somewhere new would receive the key.
  let made = models().register(asked("chat", "http://elsewhere.example/v1", 4096));
  expect(made.fault != "");
  expect(made.fault.indexOf("elsewhere.example") >= 0);
});
