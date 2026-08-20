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
import { ModelChoiceService } from "./routes/inference/model-choices/model-choice.service.ts";

let database: Db = sqlite();

function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

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

  let choice = new ModelChoiceService(database).one(out.modelChoiceId);
  expect(jsonText(choice, "kind") == "config");
  expect(jsonText(choice, "configId") == out.modelConfigId);
  expect(jsonRaw(choice, "enabled") != "0");

  let config = new ModelConfigService(database).one(out.modelConfigId);
  expect(jsonText(config, "modelId") == out.modelId);
});

test("knobs left at zero take a working default, never zero", () => {
  fresh();
  let made = models().register(asked("chat", "http://127.0.0.1:8090/v1", 0));
  expect(made.fault == "");
  let out: ModelRegistered = JSON.parse<ModelRegistered>(made.document);
  let config = new ModelConfigService(database).one(out.modelConfigId);

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

  let made = models().register(asked("chat", "http://elsewhere.example/v1", 4096));
  expect(made.fault != "");
  expect(made.fault.indexOf("elsewhere.example") >= 0);
});
