import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { EnvRow, EnvEnsure, EnvEnsured, EnvSweep, ENV_IDLE_MS, envPlan, envEnsure, envIdle, envForget, envList, envContainerName, envDockerOverride, envDockerUp, envDockerForget, envOwned, envDrop, envImagePresent, EnvOwnedRow } from "./environments.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_env_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS environments");
  migrate(database, envPlan(database));
}

const FAKE_DIR = "/tmp/agents_env_fake";
const FAKE_LOG = "/tmp/agents_env_fake/argv.log";

function fakeDocker(script: string): void {
  if (!fs.existsSync(FAKE_DIR)) {
    fs.mkdirSync(FAKE_DIR);
  }
  let bin = FAKE_DIR + "/docker";
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 493);
  fs.writeFileSync(FAKE_LOG, "");
  envDockerOverride(bin);
}

function dockerFine(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo true; fi\n"
    + "exit 0\n");
}

function dockerStoppedBehindOurBack(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo false; fi\n"
    + "exit 0\n");
}

function dockerBroken(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "echo \"Cannot connect to the Docker daemon\" >&2\n"
    + "exit 1\n");
}

function dockerPruned(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"start\" ]; then echo \"Error response from daemon: No such container\" >&2; exit 1; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo \"Error: No such object\" >&2; exit 1; fi\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "exit 0\n");
}

function argvLines(): string[] {
  let held = fs.readFileSync(FAKE_LOG);
  let out: string[] = [];
  let lines = held.split("\n");
  let i: int = 0;
  while (i < lines.length) {
    if (lines[i] != "") {
      out.push(lines[i]);
    }
    i = i + 1;
  }
  return out;
}

function clearLog(): void {
  fs.writeFileSync(FAKE_LOG, "");
}

function ensure(threadId: string, name: string, image: string, now: string): EnvEnsured {
  let e: EnvEnsure = { threadId: threadId, name: name, image: image, network: false, now: now };
  return envEnsure(database, e);
}

function sweep(now: string, idleMs: int): int {
  let s: EnvSweep = { now: now, idleMs: idleMs };
  return envIdle(database, s);
}

test("first use creates the container and the row, named main by default", () => {
  fresh();
  dockerFine();
  let made = ensure("t1", "", "python:3.12-slim", "1700000000000");

  expect(made.ok);
  expect(made.created);
  expect(!made.warmed);
  expect(made.container == "agents-env-t1-main");
  expect(made.problem == "");

  let asked = argvLines();
  expect(asked.length == 2);
  expect(asked[0] == "run -d --name agents-env-t1-main -v agents-ws-t1:/workspace --memory 1024m --cpus 2 --pids-limit 256 --shm-size 512m --security-opt no-new-privileges --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --network none --entrypoint sleep python:3.12-slim infinity");
  expect(asked[1].indexOf("exec agents-env-t1-main sh -c") == 0);
  expect(asked[1].indexOf("/workspace") > 0);

  let rows = envList(database, "t1");
  expect(rows.length == 1);
  expect(rows[0].name == "main");
  expect(rows[0].image == "python:3.12-slim");
  expect(rows[0].status == "running");
  expect(rows[0].network == 0);
  expect(rows[0].lastUsedAt == "1700000000000");
});

test("a second call reuses the running container, having asked docker whether it is up", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  clearLog();

  let again = ensure("t1", "main", "python:3.12-slim", "1700000005000");
  expect(again.ok);
  expect(!again.created);
  expect(!again.warmed);

  let asked = argvLines();
  expect(asked.length == 1);
  expect(asked[0] == "inspect -f {{.State.Running}} agents-env-t1-main");

  let rows = envList(database, "t1");
  expect(rows.length == 1);
  expect(rows[0].lastUsedAt == "1700000005000");
});

test("returning to a stopped environment is a docker start, not a create", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  expect(sweep("1700000900001", ENV_IDLE_MS) == 1);
  clearLog();
  dockerStoppedBehindOurBack();

  let back = ensure("t1", "main", "", "1700001000000");
  expect(back.ok);
  expect(back.warmed);
  expect(!back.created);

  let asked = argvLines();
  expect(asked.length == 2);
  expect(asked[0] == "inspect -f {{.State.Running}} agents-env-t1-main");
  expect(asked[1] == "start agents-env-t1-main");

  let rows = envList(database, "t1");
  expect(rows[0].status == "running");
});

test("a container that stopped behind the row's back is started, not exec'd into", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  expect(envList(database, "t1")[0].status == "running");
  clearLog();
  dockerStoppedBehindOurBack();

  let back = ensure("t1", "main", "python:3.12-slim", "1700001000000");
  expect(back.ok);
  expect(back.warmed);
  expect(!back.created);

  let asked = argvLines();
  expect(asked.length == 2);
  expect(asked[0] == "inspect -f {{.State.Running}} agents-env-t1-main");
  expect(asked[1] == "start agents-env-t1-main");
});

test("the idle sweep stops what is past the deadline and keeps what is not", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  ensure("t2", "main", "python:3.12-slim", "1700000600000");
  clearLog();

  expect(sweep("1700000900000", ENV_IDLE_MS) == 1);

  let asked = argvLines();
  expect(asked.length == 1);
  expect(asked[0] == "stop agents-env-t1-main");

  expect(envList(database, "t1")[0].status == "stopped");
  expect(envList(database, "t2")[0].status == "running");
});

test("the deadline arithmetic survives a borrow across every digit", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "999999999998");
  ensure("t2", "main", "python:3.12-slim", "1000000000000");

  expect(sweep("1000000000000", 1) == 1);
  expect(envList(database, "t1")[0].status == "stopped");
  expect(envList(database, "t2")[0].status == "running");
});

test("forgetting a thread removes its rows and its containers, and only its own", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  ensure("t1", "web", "node:22-slim", "1700000001000");
  ensure("t2", "main", "python:3.12-slim", "1700000002000");
  clearLog();

  envForget(database, "t1");

  let asked = argvLines();
  expect(asked.length == 3);
  expect(asked[0] == "rm -f agents-env-t1-main");
  expect(asked[1] == "rm -f agents-env-t1-web");
  expect(asked[2] == "volume rm -f agents-ws-t1");

  expect(envList(database, "t1").length == 0);
  expect(envList(database, "t2").length == 1);
});

test("container names are docker-legal whatever the thread id holds", () => {
  expect(envContainerName("t 1/x", "wé b") == "agents-env-t-1-x-w---b");
  expect(envContainerName("thread.A_9", "main") == "agents-env-thread.A_9-main");

  fresh();
  dockerFine();
  let made = ensure("t 1/x", "", "python:3.12-slim", "1700000000000");
  expect(made.ok);
  expect(made.container == "agents-env-t-1-x-main");
  let asked = argvLines();
  expect(asked[0] == "run -d --name agents-env-t-1-x-main -v agents-ws-t-1-x:/workspace --memory 1024m --cpus 2 --pids-limit 256 --shm-size 512m --security-opt no-new-privileges --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --network none --entrypoint sleep python:3.12-slim infinity");
});

test("a docker failure is a problem sentence, not a thrown error and not a row", () => {
  fresh();
  dockerBroken();
  let made = ensure("t1", "main", "python:3.12-slim", "1700000000000");

  expect(!made.ok);
  expect(made.created == false);
  expect(made.problem != "");
  expect(made.problem.includes("docker"));
  expect(made.problem.includes("Cannot connect to the Docker daemon"));

  expect(envList(database, "t1").length == 0);
});

test("a pruned container is recreated from the row's image, reported as created", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  expect(sweep("1700000900001", ENV_IDLE_MS) == 1);

  dockerPruned();
  let back = ensure("t1", "main", "", "1700001000000");
  expect(back.ok);
  expect(back.created);
  expect(!back.warmed);

  let asked = argvLines();
  expect(asked.length == 5);
  expect(asked[0] == "inspect -f {{.State.Running}} agents-env-t1-main");
  expect(asked[1] == "start agents-env-t1-main");
  expect(asked[2] == "rm -f agents-env-t1-main");
  expect(asked[3] == "run -d --name agents-env-t1-main -v agents-ws-t1:/workspace --memory 1024m --cpus 2 --pids-limit 256 --shm-size 512m --security-opt no-new-privileges --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --network none --entrypoint sleep python:3.12-slim infinity");
  expect(asked[4].indexOf("exec agents-env-t1-main sh -c") == 0);

  expect(envList(database, "t1")[0].status == "running");
});

test("an environment needs a conversation and, on first use, an image", () => {
  fresh();
  dockerFine();

  let unowned = ensure("", "main", "python:3.12-slim", "1700000000000");
  expect(!unowned.ok);
  expect(unowned.problem != "");

  let imageless = ensure("t1", "main", "", "1700000000000");
  expect(!imageless.ok);
  expect(imageless.problem != "");

  expect(argvLines().length == 0);
  expect(envList(database, "t1").length == 0);
});

test("two names in one thread are two rows and two containers", () => {
  fresh();
  dockerFine();
  let first = ensure("t1", "main", "python:3.12-slim", "1700000000000");
  let second = ensure("t1", "web", "node:22-slim", "1700000001000");
  expect(first.container != second.container);

  let rows = envList(database, "t1");
  expect(rows.length == 2);
  expect(rows[0].name == "main");
  expect(rows[1].name == "web");
  expect(rows[1].image == "node:22-slim");
});

test("a container is created with its guard rails: caps dropped, no new privileges, resources bounded", () => {
  fresh();
  dockerFine();
  ensure("t1", "", "python:3.12-slim", "1700000000000");
  let made = argvLines()[0];

  expect(made.indexOf("--memory 1024m") > 0);
  expect(made.indexOf("--cpus 2") > 0);
  expect(made.indexOf("--pids-limit 256") > 0);
  expect(made.indexOf("--shm-size 512m") > 0);
  expect(made.indexOf("--security-opt no-new-privileges") > 0);
  expect(made.indexOf("--cap-drop ALL") > 0);
  expect(made.indexOf("--cap-add CHOWN") > 0);
  expect(made.indexOf("--cap-add DAC_OVERRIDE") > 0);
  expect(made.indexOf("--cap-add FOWNER") > 0);
  expect(made.indexOf("--cap-add SETUID") > 0);
  expect(made.indexOf("--cap-add SETGID") > 0);
  expect(made.indexOf("SYS_ADMIN") < 0);
  expect(made.indexOf("NET_ADMIN") < 0);
  expect(made.indexOf("NET_RAW") < 0);
  expect(made.indexOf("SYS_PTRACE") < 0);
  expect(made.indexOf("--privileged") < 0);
});

test("the probe asks the daemon for its version, not the client for its own", () => {
  dockerFine();
  envDockerForget();
  expect(envDockerUp("1700000000000"));
  expect(argvLines()[0] == "version --format {{.Server.Version}}");
});

test("a daemon that cannot be reached is an answer, not an exception", () => {
  dockerBroken();
  envDockerForget();
  expect(!envDockerUp("1700000000000"));
});

test("the answer is reused for a few seconds, because the probe's door is the public one", () => {
  dockerFine();
  envDockerForget();
  expect(envDockerUp("1700000000000"));
  clearLog();

  dockerBroken();
  expect(envDockerUp("1700000004999"));
  expect(argvLines().length == 0);

  expect(!envDockerUp("1700000005001"));
  expect(argvLines().length == 1);
});

test("an image with its own entrypoint still becomes an environment", () => {
  fresh();
  dockerFine();
  ensure("t1", "", "nuralyio/docflow-validator:latest", "1700000000000");
  let made = argvLines()[0];
  expect(made.indexOf("--entrypoint sleep nuralyio/docflow-validator:latest infinity") > 0);
  expect(made.endsWith("infinity"));
});

function withThreads(): void {
  execute(database, "DROP TABLE IF EXISTS threads");
  execute(database, "CREATE TABLE threads (id text PRIMARY KEY, owner text, title text)");
  execute(database, "INSERT INTO threads VALUES ('t1','o1','Scrape the tenders site')");
  execute(database, "INSERT INTO threads VALUES ('t2','o1','Weather digest')");
  execute(database, "INSERT INTO threads VALUES ('t9','o2','Somebody else''s')");
}

test("envOwned lists a person's containers with their conversations' titles, and nobody else's", () => {
  fresh();
  withThreads();
  dockerFine();
  envEnsure(database, { threadId: "t1", name: "main", image: "img:1", network: true, now: "1000" });
  envEnsure(database, {
    threadId: "t2",
    name: "office",
    image: "img:2",
    network: true,
    now: "2000",
  });
  envEnsure(database, { threadId: "t9", name: "main", image: "img:1", network: true, now: "3000" });
  let mine = envOwned(database, "o1");
  expect(mine.length == 2);
  expect(mine[0].threadTitle == "Weather digest" || mine[1].threadTitle == "Weather digest");
  let i: int = 0;
  while (i < mine.length) {
    expect(mine[i].threadId != "t9");
    i = i + 1;
  }
  expect(envOwned(database, "o3").length == 0);
});

test("envDrop takes the container and row, and the workspace volume with the last one", () => {
  fresh();
  withThreads();
  dockerFine();
  envEnsure(database, { threadId: "t1", name: "main", image: "img:1", network: true, now: "1000" });
  envEnsure(database, {
    threadId: "t1",
    name: "office",
    image: "img:2",
    network: true,
    now: "1000",
  });
  fs.writeFileSync(FAKE_LOG, "");
  expect(envDrop(database, "t1", "main"));
  let logged = fs.readFileSync(FAKE_LOG);
  expect(logged.indexOf("rm -f " + envContainerName("t1", "main")) >= 0);
  expect(logged.indexOf("volume rm") < 0);
  expect(envList(database, "t1").length == 1);
  expect(envDrop(database, "t1", "office"));
  expect(fs.readFileSync(FAKE_LOG).indexOf("volume rm -f agents-ws-t1") >= 0);
  expect(envList(database, "t1").length == 0);
  expect(!envDrop(database, "t1", "office"));
});

test("envImagePresent asks the daemon and believes the answer", () => {
  fresh();
  dockerFine();
  expect(envImagePresent("img:1"));
  expect(!envImagePresent(""));
  fakeDocker("#!/bin/sh\necho \"$@\" >> " + FAKE_LOG + "\nexit 1\n");
  expect(!envImagePresent("img:ghost"));
});
