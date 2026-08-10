import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { UserEnvRow, createUserEnv, forgetUserEnv, userEnvById, userEnvByName, userEnvsOf, userEnvsPlan, uenvDockerOverride, uenvTag, MAX_USER_ENVS_PER_OWNER } from "./user-environments.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_uenv_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS user_environments");
  migrate(database, userEnvsPlan(database));
}

const FAKE_DIR = "/tmp/agents_uenv_fake";
const FAKE_LOG = "/tmp/agents_uenv_fake/argv.log";

function fakeDocker(script: string): void {
  if (!fs.existsSync(FAKE_DIR)) { fs.mkdirSync(FAKE_DIR); }
  let bin = FAKE_DIR + "/docker";
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 493);
  fs.writeFileSync(FAKE_LOG, "");
  uenvDockerOverride(bin);
}

function dockerFine(): void {
  fakeDocker("#!/bin/sh\necho \"$@\" >> " + FAKE_LOG + "\nexit 0\n");
}

test("a pulled-image environment is created only once the pull succeeds", () => {
  fresh();
  dockerFine();
  let made = createUserEnv(database, {
    owner: "o1", name: "scraper", image: "python:3.12-slim", dockerfile: "", now: "t1",
  });
  expect(made.id != "");
  expect(fs.readFileSync(FAKE_LOG).indexOf("pull python:3.12-slim") >= 0);
  let row = userEnvById(database, made.id, "o1");
  expect(row.image == "python:3.12-slim");
  expect(row.source == "image");
  expect(userEnvByName(database, "o1", "SCR_APER").id == made.id);
});

test("a failed pull refuses the row, carrying the puller's own words", () => {
  fresh();
  fakeDocker("#!/bin/sh\necho \"$@\" >> " + FAKE_LOG + "\necho 'manifest unknown' >&2\nexit 1\n");
  let made = createUserEnv(database, {
    owner: "o1", name: "ghost", image: "nosuch:v9", dockerfile: "", now: "t1",
  });
  expect(made.id == "");
  expect(made.problem.indexOf("manifest unknown") >= 0);
  expect(userEnvsOf(database, "o1").length == 0);
});

test("a Dockerfile builds into a deterministic tag, from a context holding nothing else", () => {
  fresh();
  dockerFine();
  let made = createUserEnv(database, {
    owner: "o1", name: "mine", image: "",
    dockerfile: "FROM python:3.12-slim\nRUN pip install requests", now: "t1",
  });
  expect(made.id != "");
  let logged = fs.readFileSync(FAKE_LOG);
  expect(logged.indexOf("build -t " + uenvTag(made.id)) >= 0);
  let row = userEnvById(database, made.id, "o1");
  expect(row.source == "dockerfile");
  expect(row.image == uenvTag(made.id));
  expect(!fs.existsSync("/tmp/agents-uenv-" + made.id));
});

test("a failed build refuses the row with the build's last lines", () => {
  fresh();
  fakeDocker("#!/bin/sh\necho \"$@\" >> " + FAKE_LOG + "\necho 'Step 2/2 : RUN nonsense' >&2\necho 'nonsense: not found' >&2\nexit 1\n");
  let made = createUserEnv(database, {
    owner: "o1", name: "broken", image: "", dockerfile: "FROM x\nRUN nonsense", now: "t1",
  });
  expect(made.id == "");
  expect(made.problem.indexOf("not found") >= 0);
});

test("the shapes an environment refuses before docker is asked", () => {
  fresh();
  dockerFine();
  let both = createUserEnv(database, { owner: "o1", name: "x", image: "a:1", dockerfile: "FROM a", now: "t1" });
  expect(both.problem.indexOf("not both") >= 0);
  let neither = createUserEnv(database, { owner: "o1", name: "x", image: "", dockerfile: "", now: "t1" });
  expect(neither.problem.indexOf("one of the two") >= 0);
  let reserved = createUserEnv(database, { owner: "o1", name: "main", image: "a:1", dockerfile: "", now: "t1" });
  expect(reserved.problem.indexOf("already means something") >= 0);
  let fromless = createUserEnv(database, { owner: "o1", name: "x", image: "", dockerfile: "RUN echo hi", now: "t1" });
  expect(fromless.problem.indexOf("FROM") >= 0);
  expect(fs.readFileSync(FAKE_LOG) == "");
});

test("somebody else's environment is absent, and deleting mine removes only a built image", () => {
  fresh();
  dockerFine();
  let pulled = createUserEnv(database, { owner: "o1", name: "shared", image: "python:3.12-slim", dockerfile: "", now: "t1" });
  let built = createUserEnv(database, { owner: "o1", name: "own", image: "", dockerfile: "FROM x", now: "t1" });
  expect(userEnvById(database, pulled.id, "o2").id == "");
  expect(!forgetUserEnv(database, pulled.id, "o2"));
  fs.writeFileSync(FAKE_LOG, "");
  expect(forgetUserEnv(database, pulled.id, "o1"));
  expect(fs.readFileSync(FAKE_LOG).indexOf("image rm") < 0);
  expect(forgetUserEnv(database, built.id, "o1"));
  expect(fs.readFileSync(FAKE_LOG).indexOf("image rm -f " + uenvTag(built.id)) >= 0);
  expect(userEnvsOf(database, "o1").length == 0);
});

test("environments per owner are bounded", () => {
  fresh();
  dockerFine();
  let i: int = 0;
  while (i < MAX_USER_ENVS_PER_OWNER) {
    expect(createUserEnv(database, { owner: "o1", name: "e" + `${i}`, image: "a:1", dockerfile: "", now: "t1" }).id != "");
    i = i + 1;
  }
  let over = createUserEnv(database, { owner: "o1", name: "one-more", image: "a:1", dockerfile: "", now: "t1" });
  expect(over.id == "");
  expect(over.problem.indexOf("delete one") >= 0);
});
