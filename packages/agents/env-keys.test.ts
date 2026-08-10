import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute, dropTable, findById } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { agentsMapping, credentialsMapping, mcpServersMapping, modelConfigsMapping, modelsMapping, promptsMapping, schemaPlan } from "./schema.ts";
import { hasCredential } from "./credentials.ts";
import { EnvKeyRow, createEnvKey, envKeyById, envKeyByName, envKeyFileBody, envKeyNames, envKeysMapping, envKeysOf, envKeysOwnedBy, envKeysPlan, forgetEnvKey, MAX_ENV_KEYS_PER_ENV } from "./env-keys.ts";

let database: Db = sqlite();

function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_env_keys_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP TABLE IF EXISTS auth_providers");
  execute(database, "DROP TABLE IF EXISTS script_images");
  dropTable(database, envKeysMapping());
  let plan = schemaPlan(database);
  let extra = envKeysPlan(database);
  let i: int = 0;
  while (i < extra.length) {
    plan.push(extra[i]);
    i = i + 1;
  }
  migrate(database, plan);
}

function stored(name: string, owner: string, imageId: string, value: string): string {
  let made = createEnvKey(database, {
    owner: owner, imageId: imageId, name: name, value: value,
    master: testKey(), now: "t1",
  });
  return made.id;
}

test("a stored key lists by name and its value is in neither row", () => {
  fresh();
  let id = stored("OPENAI_API_KEY", "o1", "img-runtime", "sk-test-0001");
  expect(id != "");
  let listed = envKeysOf(database, "o1", "img-runtime");
  expect(listed.indexOf("OPENAI_API_KEY") >= 0);
  expect(listed.indexOf("sk-test") < 0);
  expect(findById(database, envKeysMapping(), id).indexOf("sk-test") < 0);
  expect(envKeyFileBody(database, "o1", "img-runtime", testKey()) == "OPENAI_API_KEY=sk-test-0001\n");
});

test("keys are per environment, so one name can exist in two of them", () => {
  fresh();
  expect(stored("API_KEY", "o1", "img-runtime", "one") != "");
  let again = createEnvKey(database, {
    owner: "o1", imageId: "img-runtime", name: "API_KEY", value: "two",
    master: testKey(), now: "t2",
  });
  expect(again.id == "");
  expect(again.problem.indexOf("already a key called") >= 0);
  expect(stored("API_KEY", "o1", "img-office", "three") != "");
  expect(envKeyFileBody(database, "o1", "img-runtime", testKey()) == "API_KEY=one\n");
  expect(envKeyFileBody(database, "o1", "img-office", testKey()) == "API_KEY=three\n");
  expect(JSON.parse<EnvKeyRow[]>(envKeysOwnedBy(database, "o1")).length == 2);
});

test("a name the container reads before the script is refused", () => {
  fresh();
  let path = createEnvKey(database, {
    owner: "o1", imageId: "i", name: "PATH", value: "/tmp",
    master: testKey(), now: "t1",
  });
  expect(path.id == "");
  expect(path.problem.indexOf("before your script") >= 0);
  let preload = createEnvKey(database, {
    owner: "o1", imageId: "i", name: "LD_PRELOAD", value: "/tmp/evil.so",
    master: testKey(), now: "t1",
  });
  expect(preload.id == "");
  let lower = createEnvKey(database, {
    owner: "o1", imageId: "i", name: "ld_preload", value: "/tmp/evil.so",
    master: testKey(), now: "t1",
  });
  expect(lower.id == "");
});

test("a name that is not a variable name is refused", () => {
  fresh();
  let dashed = createEnvKey(database, {
    owner: "o1", imageId: "i", name: "MY-KEY", value: "v", master: testKey(), now: "t1",
  });
  expect(dashed.id == "");
  expect(dashed.problem.indexOf("not a variable name") >= 0);
  let leading = createEnvKey(database, {
    owner: "o1", imageId: "i", name: "1KEY", value: "v", master: testKey(), now: "t1",
  });
  expect(leading.id == "");
  let equals = createEnvKey(database, {
    owner: "o1", imageId: "i", name: "A=B", value: "v", master: testKey(), now: "t1",
  });
  expect(equals.id == "");
});

test("a line break in a value is refused, because the file format has no escape", () => {
  fresh();
  let broken = createEnvKey(database, {
    owner: "o1", imageId: "i", name: "TOKEN", value: "abc\nLD_PRELOAD=/tmp/evil.so",
    master: testKey(), now: "t1",
  });
  expect(broken.id == "");
  expect(broken.problem.indexOf("line break") >= 0);
  expect(envKeyFileBody(database, "o1", "i", testKey()) == "");
});

test("somebody else's key is absent, not forbidden", () => {
  fresh();
  let id = stored("TOKEN", "o1", "i", "v");
  expect(envKeyById(database, id, "o2").id == "");
  expect(envKeyByName(database, "TOKEN", "o2", "i").id == "");
  expect(envKeysOf(database, "o2", "i") == "[]");
  expect(!forgetEnvKey(database, id, "o2"));
  expect(envKeyById(database, id, "o1").id == id);
  expect(envKeyFileBody(database, "o2", "i", testKey()) == "");
});

test("deleting a key takes its envelope with it", () => {
  fresh();
  let id = stored("TOKEN", "o1", "i", "v");
  expect(hasCredential(database, "envkey:" + id));
  expect(forgetEnvKey(database, id, "o1"));
  expect(!hasCredential(database, "envkey:" + id));
  expect(envKeyById(database, id, "o1").id == "");
});

test("a key whose envelope will not open is left out, not passed empty", () => {
  fresh();
  stored("TOKEN", "o1", "i", "v");
  let wrong = "ffffffffffffffffffffffffffffffff";
  expect(envKeyFileBody(database, "o1", "i", wrong) == "");
  expect(envKeyNames(database, "o1", "i").length == 1);
});

test("the names are offerable without any value being held", () => {
  fresh();
  stored("STRIPE_KEY", "o1", "i", "sk-1");
  stored("WEATHER_KEY", "o1", "i", "sk-2");
  let names = envKeyNames(database, "o1", "i");
  expect(names.length == 2);
  expect(names[0] == "STRIPE_KEY");
  expect(names[1] == "WEATHER_KEY");
});

test("an environment holds a bounded number of keys", () => {
  fresh();
  let i: int = 0;
  while (i < MAX_ENV_KEYS_PER_ENV) {
    expect(stored("KEY_" + `${i}`, "o1", "i", "v") != "");
    i = i + 1;
  }
  let over = createEnvKey(database, {
    owner: "o1", imageId: "i", name: "ONE_MORE", value: "v", master: testKey(), now: "t1",
  });
  expect(over.id == "");
  expect(over.problem.indexOf("delete one before adding another") >= 0);
});
