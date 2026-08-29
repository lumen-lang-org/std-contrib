import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { EnvRow, EnvEnsure, EnvEnsured, EnvSweep, ENV_IDLE_MS, envPlan, envEnsure, envIdle, envNetworkReap, envForget, envList, envContainerName, envDockerOverride, envDockerUp, envDockerForget, envOwned, envDrop, envImagePresent, envBySlug, envBindOverride, envBindAddr, envServePort, envForwardArgs, envForwardPid, envProbeOverride, envReforward, envServing, envMarkAgent, envMarkSynced, envSeccompOverride, EnvOwnedRow } from "./environments.ts";

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
  let e: EnvEnsure = { threadId: threadId, name: name, image: image, network: false, serve: false, command: "", start: true, agent: false, now: now };
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
  expect(made.fault == "");

  let asked = argvLines();
  expect(asked.length == 2);
  expect(asked[0] == "run -d --name agents-env-t1-main -v agents-ws-t1:/workspace --memory 1024m --cpus 2 --pids-limit 256 --shm-size 512m --security-opt no-new-privileges --cap-drop ALL --read-only --tmpfs /tmp:rw,nosuid,size=64m -v agents-run-t1:/artifacts -v agents-skills-t1:/skills -v agents-home-t1:/home/sandbox --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --network none --entrypoint sleep python:3.12-slim infinity");
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
  // Each container, then the network it had to itself, then every volume the
  // thread owns — a volume left behind is a volume nobody ever collects.
  expect(asked.length == 8);
  expect(asked[0] == "rm -f agents-env-t1-main");
  expect(asked[1] == "network rm agents-net-t1-main");
  expect(asked[2] == "rm -f agents-env-t1-web");
  expect(asked[3] == "network rm agents-net-t1-web");
  expect(asked[4] == "volume rm -f agents-ws-t1");
  expect(asked[5] == "volume rm -f agents-home-t1");
  expect(asked[6] == "volume rm -f agents-run-t1");
  expect(asked[7] == "volume rm -f agents-skills-t1");

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
  expect(asked[0] == "run -d --name agents-env-t-1-x-main -v agents-ws-t-1-x:/workspace --memory 1024m --cpus 2 --pids-limit 256 --shm-size 512m --security-opt no-new-privileges --cap-drop ALL --read-only --tmpfs /tmp:rw,nosuid,size=64m -v agents-run-t-1-x:/artifacts -v agents-skills-t-1-x:/skills -v agents-home-t-1-x:/home/sandbox --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --network none --entrypoint sleep python:3.12-slim infinity");
});

test("a docker failure is a fault sentence, not a thrown error and not a row", () => {
  fresh();
  dockerBroken();
  let made = ensure("t1", "main", "python:3.12-slim", "1700000000000");

  expect(!made.ok);
  expect(made.created == false);
  expect(made.fault != "");
  expect(made.fault.includes("docker"));
  expect(made.fault.includes("Cannot connect to the Docker daemon"));

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
  expect(asked.length == 6);
  expect(asked[0] == "inspect -f {{.State.Running}} agents-env-t1-main");
  expect(asked[1] == "start agents-env-t1-main");
  // Asked a second time before tearing anything down: a start that fails
  // because another ensure is mid-rebuild is not a container that is gone.
  expect(asked[2] == "inspect -f {{.State.Running}} agents-env-t1-main");
  expect(asked[3] == "rm -f agents-env-t1-main");
  expect(asked[4] == "run -d --name agents-env-t1-main -v agents-ws-t1:/workspace --memory 1024m --cpus 2 --pids-limit 256 --shm-size 512m --security-opt no-new-privileges --cap-drop ALL --read-only --tmpfs /tmp:rw,nosuid,size=64m -v agents-run-t1:/artifacts -v agents-skills-t1:/skills -v agents-home-t1:/home/sandbox --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --network none --entrypoint sleep python:3.12-slim infinity");
  expect(asked[5].indexOf("exec agents-env-t1-main sh -c") == 0);

  expect(envList(database, "t1")[0].status == "running");
});

test("an environment needs a conversation and, on first use, an image", () => {
  fresh();
  dockerFine();

  let unowned = ensure("", "main", "python:3.12-slim", "1700000000000");
  expect(!unowned.ok);
  expect(unowned.fault != "");

  let imageless = ensure("t1", "main", "", "1700000000000");
  expect(!imageless.ok);
  expect(imageless.fault != "");

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
  envEnsure(database, { threadId: "t1", name: "main", image: "img:1", network: true, serve: false, command: "", start: true, agent: false, now: "1000" });
  envEnsure(database, {
    threadId: "t2",
    name: "office",
    image: "img:2",
    network: true,
    serve: false,
    command: "",
    start: true, agent: false,
    now: "2000",
  });
  envEnsure(database, { threadId: "t9", name: "main", image: "img:1", network: true, serve: false, command: "", start: true, agent: false, now: "3000" });
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
  envEnsure(database, { threadId: "t1", name: "main", image: "img:1", network: true, serve: false, command: "", start: true, agent: false, now: "1000" });
  envEnsure(database, {
    threadId: "t1",
    name: "office",
    image: "img:2",
    network: true,
    serve: false,
    command: "",
    start: true, agent: false,
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

const GATEWAY_SIDE = "100.109.60.43";

function dockerServing(atPort: string): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo true; fi\n"
    + "if [ \"$1\" = \"port\" ]; then echo \"" + GATEWAY_SIDE + ":" + atPort + "\"; fi\n"
    + "exit 0\n");
}

function serve(threadId: string, now: string): EnvEnsured {
  let e: EnvEnsure = {
    threadId: threadId, name: "web", image: "node:22", network: true, serve: true, command: "", start: true, agent: false, now: now,
  };
  return envEnsure(database, e);
}

function onlyEnv(threadId: string): EnvRow {
  let rows = envList(database, threadId);
  return rows[0];
}

test("a serving environment publishes one port, bound to the address the gateway reaches", () => {
  fresh();
  envBindOverride(GATEWAY_SIDE);
  dockerServing("49154");
  let up = serve("t1", "1700000000000");

  expect(up.ok);
  expect(up.hostPort == 49154);
  let lines = argvLines();
  // The network is made first, then the volumes are given to the uid that will
  // use them, then the container joins both.
  expect(lines[0] == "network create agents-net-t1-web");
  expect(lines[1].indexOf("run --rm -u 0") == 0);
  expect(lines[1].indexOf("chown") > 0);
  let made = lines[2];
  // Hardened: no root, no capabilities, and an image it cannot rewrite.
  expect(made.indexOf("--read-only") > 0);
  // No profile configured in a test, so none is passed and docker's default
  // stands — the flag is opt-in, never a half-written path.
  expect(made.indexOf("seccomp=") < 0);
  expect(made.indexOf("apparmor=") < 0);
  // And no runtime: unasked-for, the daemon's own is used. A half-configured
  // runtime name would fail every container at creation.
  expect(made.indexOf("--runtime") < 0);
  expect(made.indexOf("--user 65534:65534") > 0);
  expect(made.indexOf("--cap-drop ALL") > 0);
  expect(made.indexOf("--cap-add") < 0);
  expect(made.indexOf("HOME=/home/sandbox") > 0);
  // HOME is a volume of its own: npm's cache inside /workspace would be swept
  // back as artifacts, and is enough to make `npm create` scaffold nothing.
  expect(made.indexOf("agents-home-t1:/home/sandbox") > 0);
  expect(made.indexOf("-p " + GATEWAY_SIDE + "::3000") > 0);
  // Its own network, never the default bridge: everything on that bridge can
  // reach everything else on it, which is how one conversation's container
  // came to be able to fetch another conversation's page.
  expect(made.indexOf("--network agents-net-t1-web") > 0);
  expect(made.indexOf("--network none") < 0);
  expect(made.indexOf("--network bridge") < 0);
  expect(onlyEnv("t1").hostPort == 49154);
  expect(onlyEnv("t1").servePort == 3000);
  envBindOverride("");
});

test("an environment cannot reach another, because it is alone on its network", () => {
  fresh();
  envBindOverride(GATEWAY_SIDE);
  dockerServing("49154");
  expect(serve("t1", "1700000000000").ok);
  expect(serve("t2", "1700000000001").ok);

  let asked = argvLines();
  let first = "";
  let second = "";
  let i: int = 0;
  while (i < asked.length) {
    if (asked[i].startsWith("run -d --name agents-env-t1-web")) { first = asked[i]; }
    if (asked[i].startsWith("run -d --name agents-env-t2-web")) { second = asked[i]; }
    i = i + 1;
  }
  expect(first != "" && second != "");
  expect(first.indexOf("--network agents-net-t1-web") > 0);
  expect(second.indexOf("--network agents-net-t2-web") > 0);
  envBindOverride("");
});

test("dropping an environment takes its network with it", () => {
  fresh();
  envBindOverride(GATEWAY_SIDE);
  dockerServing("49154");
  expect(serve("t1", "1700000000000").ok);
  clearLog();
  expect(envDrop(database, "t1", "web"));

  let asked = argvLines();
  // A network per environment is a network leaked per environment otherwise,
  // and docker's address pool is not endless.
  let removed = false;
  let i: int = 0;
  while (i < asked.length) {
    if (asked[i] == "network rm agents-net-t1-web") { removed = true; }
    i = i + 1;
  }
  expect(removed);
  envBindOverride("");
});

test("0.0.0.0 is not a bind address, so a slip in the config exposes nothing", () => {
  fresh();
  envBindOverride("0.0.0.0");
  dockerServing("49154");
  let up = serve("t1", "1700000000000");

  expect(!up.ok);
  expect(up.fault.indexOf("0.0.0.0") > 0);
  expect(envBindAddr() == "");
  expect(argvLines().length == 0);
  expect(envList(database, "t1").length == 0);
  envBindOverride("");
});

test("an environment that serves a port is refused one with no network", () => {
  fresh();
  envBindOverride(GATEWAY_SIDE);
  dockerServing("49154");
  let e: EnvEnsure = {
    threadId: "t1", name: "web", image: "node:22", network: false, serve: true, command: "", start: true, agent: false, now: "1700000000000",
  };
  let up = envEnsure(database, e);

  expect(!up.ok);
  expect(up.fault.indexOf("network") > 0);
  expect(argvLines().length == 0);
  envBindOverride("");
});

test("a warm environment's port is asked for again, because docker moves it on every start", () => {
  fresh();
  envBindOverride(GATEWAY_SIDE);
  dockerServing("49154");
  expect(serve("t1", "1700000000000").hostPort == 49154);

  dockerServing("49200");
  let again = serve("t1", "1700000060000");

  expect(again.hostPort == 49200);
  expect(onlyEnv("t1").hostPort == 49200);
  // Reused, not rebuilt: the port moved without the container doing so.
  expect(!again.created);
  envBindOverride("");
});

test("the idle sweep takes the published port with the container", () => {
  fresh();
  envBindOverride(GATEWAY_SIDE);
  dockerServing("49154");
  expect(serve("t1", "1000000000000").hostPort == 49154);

  expect(sweep("1700000000000", ENV_IDLE_MS) == 1);

  let row = onlyEnv("t1");
  expect(row.status == "stopped");
  expect(row.hostPort == 0);
  // The port inside is the deployment's contract and outlives the container.
  expect(row.servePort == 3000);
  envBindOverride("");
});

test("an environment built without a port is rebuilt to gain one, and keeps its workspace", () => {
  fresh();
  envBindOverride(GATEWAY_SIDE);
  dockerServing("49154");
  let plain: EnvEnsure = {
    threadId: "t1", name: "web", image: "node:22", network: true, serve: false, command: "", start: true, agent: false, now: "1700000000000",
  };
  expect(envEnsure(database, plain).hostPort == 0);
  // [0] is the network, [1] the container: an environment that serves nothing
  // gets no volume preparation, because it is not the hardened shape.
  expect(argvLines()[1].indexOf("-p ") < 0);
  clearLog();

  let up = serve("t1", "1700000060000");

  expect(up.created);
  expect(up.hostPort == 49154);
  expect(argvLines()[0].indexOf("rm -f") == 0);
  // The network is created again — idempotently, since the rebuild keeps it.
  expect(argvLines()[1] == "network create agents-net-t1-web");
  let remade = argvLines()[3];
  expect(remade.indexOf("-p " + GATEWAY_SIDE + "::3000") > 0);
  // The rebuild mounts the same volume, which is where the work lives.
  expect(remade.indexOf("agents-ws-t1:/workspace") > 0);
  envBindOverride("");
});

test("a script environment asks for no port and is given none", () => {
  fresh();
  envBindOverride(GATEWAY_SIDE);
  dockerServing("49154");
  let up = ensure("t1", "", "python:3.12-slim", "1700000000000");

  expect(up.hostPort == 0);
  expect(argvLines()[0].indexOf("-p ") < 0);
  expect(onlyEnv("t1").servePort == 0);
  expect(envServePort() == 3000);
  envBindOverride("");
});

test("an environment is given a name of its own: one DNS label, saying nothing about the thread", () => {
  fresh();
  dockerFine();
  let made = ensure("t1", "main", "python:3.12-slim", "1700000000000");

  expect(made.slug.length == 16);
  expect(made.slug.indexOf("t1") < 0);
  let i: int = 0;
  while (i < made.slug.length) {
    let c = made.slug.charCodeAt(i);
    expect((c >= 48 && c <= 57) || (c >= 97 && c <= 102));
    i = i + 1;
  }
  expect(onlyEnv("t1").slug == made.slug);

  // A second environment is a second name, because it is a second origin.
  let other = ensure("t1", "web", "node:22", "1700000001000");
  expect(other.slug != made.slug);
});

test("a hostname finds its environment, and an unknown one finds nothing", () => {
  fresh();
  dockerFine();
  let made = ensure("t1", "main", "python:3.12-slim", "1700000000000");

  let found = envBySlug(database, made.slug);
  expect(found.threadId == "t1");
  expect(found.name == "main");

  expect(envBySlug(database, "0123456789abcdef").threadId == "");
  expect(envBySlug(database, "").threadId == "");
});

test("an environment made before names existed is given one when it is next used", () => {
  fresh();
  dockerFine();
  expect(ensure("t1", "main", "python:3.12-slim", "1700000000000").slug.length == 16);
  execute(database, "UPDATE environments SET slug = ''");
  expect(onlyEnv("t1").slug == "");

  let back = ensure("t1", "main", "python:3.12-slim", "1700000005000");

  expect(back.slug.length == 16);
  expect(onlyEnv("t1").slug == back.slug);
});

test("a published port is carried across by a forward that binds one address only", () => {
  let args = envForwardArgs("172.17.0.1:32768", 32768, "joule-sandbox-env");

  expect(args.indexOf("-N") >= 0);
  expect(args.indexOf("ExitOnForwardFailure=yes") >= 0);
  // The whole point: this address and no other. A forward bound to every
  // interface would put the container on the internet past the gateway.
  expect(args.indexOf("172.17.0.1:32768:127.0.0.1:32768") >= 0);
  expect(args.indexOf("0.0.0.0:32768:127.0.0.1:32768") < 0);
  expect(args[args.length - 1] == "joule-sandbox-env");
});

function servingWith(command: string, now: string): EnvEnsured {
  let e: EnvEnsure = {
    threadId: "t1", name: "web", image: "node:22", network: true, serve: true,
    command: command, start: true, agent: false, now: now,
  };
  return envEnsure(database, e);
}

test("what makes an environment serve is run when it is made, and kept", () => {
  fresh();
  envBindOverride("127.0.0.1");
  dockerServing("49154");
  let up = servingWith("npm run dev", "1700000000000");

  expect(up.ok);
  // network create, the volume chown, run, then the serve command.
  let started = argvLines()[3];
  expect(started.indexOf("exec -d agents-env-t1-web sh -lc npm run dev") == 0);
  expect(onlyEnv("t1").serveCmd == "npm run dev");
  envBindOverride("");
});

test("a container that comes back is served again, and one that never left is not", () => {
  fresh();
  envBindOverride("127.0.0.1");
  dockerServing("49154");
  expect(servingWith("npm run dev", "1700000000000").ok);
  probeSays(true);
  clearLog();

  // Still running and answering: starting the command again would stack a
  // second server on a port the first one holds.
  expect(servingWith("", "1700000005000").ok);
  let quiet = argvLines();
  let i: int = 0;
  while (i < quiet.length) {
    expect(quiet[i].indexOf("exec -d") < 0);
    i = i + 1;
  }

  // Stopped behind our back, so it is started and so is what it serves — with
  // the command the row kept, which this call does not repeat.
  dockerStoppedBehindOurBack();
  probeSays(false);
  clearLog();
  let back = servingWith("", "1700000010000");
  expect(back.warmed);
  let again = argvLines();
  let saw = false;
  let j: int = 0;
  while (j < again.length) {
    if (again[j].indexOf("exec -d agents-env-t1-web sh -lc npm run dev") == 0) {
      saw = true;
    }
    j = j + 1;
  }
  expect(saw);
  expect(onlyEnv("t1").serveCmd == "npm run dev");
  envProbeOverride("");
  envBindOverride("");
});

test("an environment with nothing to serve is left idle", () => {
  fresh();
  dockerFine();
  let up = ensure("t1", "main", "python:3.12-slim", "1700000000000");

  expect(up.ok);
  let asked = argvLines();
  let i: int = 0;
  while (i < asked.length) {
    expect(asked[i].indexOf("exec -d") < 0);
    i = i + 1;
  }
  expect(onlyEnv("t1").serveCmd == "");
});

const SS_LISTING = "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process\n"
  + "LISTEN 0      5      172.17.0.1:32769    0.0.0.0:*   users:((\"python3\",pid=1111,fd=3))\n"
  + "LISTEN 0      128    172.17.0.1:32770    0.0.0.0:*   users:((\"ssh\",pid=3046088,fd=6))\n"
  + "LISTEN 0      128    127.0.0.1:8100      0.0.0.0:*   users:((\"api\",pid=2222,fd=9))\n";

test("the process holding a forward is found by its address and nothing else", () => {
  expect(envForwardPid(SS_LISTING, "172.17.0.1:32770") == 3046088);
  expect(envForwardPid(SS_LISTING, "172.17.0.1:32769") == 1111);
  // A port nothing holds, and a near-miss that must not match: killing the
  // wrong pid because a line was misread is the failure worth ruling out.
  expect(envForwardPid(SS_LISTING, "172.17.0.1:32771") == 0);
  expect(envForwardPid(SS_LISTING, "17.0.1:32770") == 0);
  expect(envForwardPid("", "172.17.0.1:32770") == 0);
});

test("the list a person sees says which of their environments can be opened", () => {
  fresh();
  withThreads();
  envBindOverride("127.0.0.1");
  dockerServing("49154");
  expect(envEnsure(database, { threadId: "t1", name: "web", image: "node:22",
    network: true, serve: true, command: "", start: true, agent: false, now: "1000" }).ok);
  expect(ensure("t2", "main", "python:3.12-slim", "2000").ok);

  let mine = envOwned(database, "o1");
  expect(mine.length == 2);
  let i: int = 0;
  while (i < mine.length) {
    if (mine[i].name == "web") {
      expect(mine[i].serving);
      expect(mine[i].servable);
      expect(mine[i].slug.length == 16);
    } else {
      // Running, and serving nothing: there is no way in to offer.
      expect(!mine[i].serving);
      expect(!mine[i].servable);
    }
    i = i + 1;
  }
  envBindOverride("");
});

test("a name another ensure just took is used, not fought over", () => {
  fresh();
  withThreads();
  envBindOverride(GATEWAY_SIDE);
  // docker refuses the create because the name is held, and the container
  // under that name is up: the console polls serve every few seconds while a
  // rebuild runs, so the second call arrives mid-flight. It wanted a running
  // container and there is one.
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ] && [ \"$2\" = \"-d\" ]; then\n"
    + "  echo 'docker: Error response from daemon: Conflict. The container name is already in use' >&2\n"
    + "  exit 125\n"
    + "fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo true; fi\n"
    + "if [ \"$1\" = \"port\" ]; then echo '3000/tcp -> 127.0.0.1:49154'; fi\n"
    + "exit 0\n");
  let up = serve("t1", "1700000000000");

  expect(up.ok);
  expect(up.fault == "");
  // And it did not tear down the container the other call had just made.
  let asked = argvLines();
  let removed = false;
  let i: int = 0;
  while (i < asked.length) {
    if (asked[i].indexOf("rm -f agents-env-t1-web") == 0) { removed = true; }
    i = i + 1;
  }
  expect(!removed);
  envBindOverride("");
});

test("an environment asleep is still one with a server in it", () => {
  fresh();
  withThreads();
  envBindOverride("127.0.0.1");
  dockerServing("49154");
  expect(envEnsure(database, { threadId: "t1", name: "web", image: "node:22",
    network: true, serve: true, command: "npm run dev", start: true, agent: false, now: "1000" }).ok);

  // Fifteen minutes later nobody has touched it, so the sweep stops it and the
  // published port goes with the container.
  let s: EnvSweep = { now: `${1000 + ENV_IDLE_MS + 1}`, idleMs: ENV_IDLE_MS };
  expect(envIdle(database, s) == 1);

  let mine = envOwned(database, "o1");
  expect(mine.length == 1);
  // Not serving — there is no port to reach. Still servable, which is what
  // keeps the button on screen offering to wake it rather than vanishing.
  expect(!mine[0].serving);
  expect(mine[0].servable);
  envBindOverride("");
});

test("a restart carries the live environments back, and leaves the rest alone", () => {
  fresh();
  envBindOverride("127.0.0.1");
  dockerServing("49154");
  expect(envEnsure(database, { threadId: "t1", name: "web", image: "node:22",
    network: true, serve: true, command: "npm run dev", start: true, agent: false, now: "1000" }).ok);
  // A script sandbox: running, serving nothing, and no forward to carry.
  expect(ensure("t2", "main", "python:3.12-slim", "2000").ok);
  clearLog();

  // The container moved while this process was down.
  dockerServing("49200");
  expect(envReforward(database, "3000") >= 0);

  let web = envList(database, "t1")[0];
  expect(web.hostPort == 49200);
  expect(web.serveCmd == "npm run dev");
  // Asked docker where it is now rather than trusting the row.
  let asked = argvLines();
  let sawPort = false;
  let i: int = 0;
  while (i < asked.length) {
    if (asked[i].indexOf("port agents-env-t1-web") == 0) { sawPort = true; }
    // Nothing is done about the one that serves nothing.
    expect(asked[i].indexOf("agents-env-t2-main") < 0);
    i = i + 1;
  }
  expect(sawPort);
  envBindOverride("");
});

/** The probe is a curl from this host now, so the tests fake that rather than
 *  docker: answering and not-answering are the two states worth pinning. */
function probeSays(answering: bool): void {
  let bin = FAKE_DIR + "/probe";
  fs.writeFileSync(bin, "#!/bin/sh\nexit " + (answering ? "0" : "1") + "\n");
  fs.chmodSync(bin, 493);
  envProbeOverride(bin);
}

function dockerRunningButEmpty(atPort: string): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo true; fi\n"
    + "if [ \"$1\" = \"port\" ]; then echo \"" + GATEWAY_SIDE + ":" + atPort + "\"; fi\n"
    // The probe: `exec <container> sh -c ...`, which is the one exec that is
    // not `exec -d`. Nothing is listening, so it fails.
    + "if [ \"$1\" = \"exec\" ] && [ \"$2\" != \"-d\" ]; then exit 1; fi\n"
    + "exit 0\n");
}

test("a container running with nothing inside is served again, whatever its state says", () => {
  fresh();
  envBindOverride("127.0.0.1");
  dockerServing("49154");
  expect(servingWith("npm run dev", "1700000000000").ok);

  // docker restart: still running, and empty. The old created-or-warmed test
  // saw a healthy container and started nothing.
  dockerServing("49154");
  probeSays(false);
  clearLog();
  let back = servingWith("", "1700000005000");

  expect(back.ok);
  expect(!back.created);
  expect(!back.warmed);
  let started = false;
  let asked = argvLines();
  let i: int = 0;
  while (i < asked.length) {
    if (asked[i].indexOf("exec -d agents-env-t1-web sh -lc npm run dev") == 0) {
      started = true;
    }
    i = i + 1;
  }
  expect(started);
});

test("a container that is answering is left to get on with it", () => {
  fresh();
  envBindOverride("127.0.0.1");
  dockerServing("49154");
  expect(servingWith("npm run dev", "1700000000000").ok);
  probeSays(true);
  clearLog();

  expect(servingWith("", "1700000005000").ok);

  let asked = argvLines();
  let i: int = 0;
  while (i < asked.length) {
    expect(asked[i].indexOf("exec -d") < 0);
    i = i + 1;
  }
  envProbeOverride("");
  envBindOverride("");
});

test("the sweep gives the network back, and waking the environment makes it again", () => {
  fresh();
  withThreads();
  envBindOverride("127.0.0.1");
  dockerServing("49154");
  expect(envEnsure(database, { threadId: "t1", name: "web", image: "node:22",
    network: true, serve: true, command: "npm run dev", start: true, agent: false, now: "1000" }).ok);

  clearLog();
  let s: EnvSweep = { now: `${1000 + ENV_IDLE_MS + 1}`, idleMs: ENV_IDLE_MS };
  expect(envIdle(database, s) == 1);
  let dropped = false;
  let asked = argvLines();
  let i: int = 0;
  while (i < asked.length) {
    if (asked[i] == "network rm agents-net-t1-web") { dropped = true; }
    i = i + 1;
  }
  expect(dropped);

  // Woken, the network is made again BEFORE the start: a stopped container
  // holds the name of a network that is no longer there. Docker now says the
  // container is down, which is what the sweep just made true.
  dockerStoppedBehindOurBack();
  clearLog();
  envEnsure(database, { threadId: "t1", name: "web", image: "node:22",
    network: true, serve: true, command: "npm run dev", start: true, agent: false, now: "2000000" });
  let again = argvLines();
  let made: int = -1;
  let started: int = -1;
  let j: int = 0;
  while (j < again.length) {
    if (again[j] == "network create agents-net-t1-web" && made < 0) { made = j; }
    if (again[j].indexOf("start agents-env-t1-web") == 0 && started < 0) { started = j; }
    j = j + 1;
  }
  expect(made >= 0);
  expect(started >= 0);
  expect(made < started);
  envBindOverride("");
});

test("a host with no address range left says so, rather than passing on a missing network", () => {
  fresh();
  withThreads();
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"network\" ] && [ \"$2\" = \"create\" ]; then\n"
    + "  echo 'Error response from daemon: all predefined address pools have been fully subnetted' >&2\n"
    + "  exit 1\n"
    + "fi\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo true; fi\n"
    + "exit 0\n");

  let refused = envEnsure(database, { threadId: "t9", name: "python", image: "python:3.12-slim",
    network: true, serve: false, command: "", start: true, agent: false, now: "1000" });
  expect(!refused.ok);
  expect(refused.fault.indexOf("no room for another environment") >= 0);
  expect(refused.fault.indexOf("not found") < 0);

  // And no container was made behind the refusal.
  let asked = argvLines();
  let ran = false;
  let i: int = 0;
  while (i < asked.length) {
    if (asked[i].indexOf("run ") == 0) { ran = true; }
    i = i + 1;
  }
  expect(!ran);
});

test("a network that is already there is not a failure", () => {
  fresh();
  withThreads();
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"network\" ] && [ \"$2\" = \"create\" ]; then\n"
    + "  echo 'Error response from daemon: network with name agents-net-t8-python already exists' >&2\n"
    + "  exit 1\n"
    + "fi\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo true; fi\n"
    + "exit 0\n");

  let made = envEnsure(database, { threadId: "t8", name: "python", image: "python:3.12-slim",
    network: true, serve: false, command: "", start: true, agent: false, now: "1000" });
  expect(made.ok);
  expect(made.fault == "");
});

test("a network nobody is on is released, and a live one is left alone", () => {
  fresh();
  withThreads();
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"network\" ] && [ \"$2\" = \"ls\" ]; then\n"
    + "  echo agents-net-t1-main\n"
    + "  echo agents-net-t7-orphan\n"
    + "fi\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "if [ \"$1\" = \"inspect\" ]; then echo true; fi\n"
    + "exit 0\n");
  expect(envEnsure(database, { threadId: "t1", name: "main", image: "python:3.12-slim",
    network: true, serve: false, command: "", start: true, agent: false, now: "1000" }).ok);

  clearLog();
  expect(envNetworkReap(database) == 1);
  let asked = argvLines();
  let removed: string[] = [];
  let i: int = 0;
  while (i < asked.length) {
    if (asked[i].indexOf("network rm ") == 0) { removed.push(asked[i]); }
    i = i + 1;
  }
  expect(removed.length == 1);
  expect(removed[0] == "network rm agents-net-t7-orphan");
});

// An environment with a joule daemon in it. It publishes no port — the engine
// reaches the daemon through docker exec and a file inbox — so everything
// below is about the two things a port used to stand in for: that the sweep
// should collect this row, and that it is busy.

test("an environment starts with no agent in it, and the columns say so", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");

  let row = onlyEnv("t1");
  expect(row.agentConn == "");
  expect(row.agentRead == 0);
});

test("a daemon is written down, and cleared with its cursor when it goes", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");

  expect(envMarkAgent(database, onlyEnv("t1"), "c17", 4096) == "");
  expect(onlyEnv("t1").agentConn == "c17");
  expect(onlyEnv("t1").agentRead == 4096);

  // The cursor goes with the id whatever the caller passes: the next daemon
  // truncates broadcast.log, so an offset kept across that points past the end.
  expect(envMarkAgent(database, onlyEnv("t1"), "", 4096) == "");
  expect(onlyEnv("t1").agentConn == "");
  expect(onlyEnv("t1").agentRead == 0);
});

test("the sweep collects an environment with an agent in it, port or no port", () => {
  fresh();
  dockerFine();
  // Two script sandboxes, neither publishing anything.
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  ensure("t2", "main", "python:3.12-slim", "1700000000000");

  // Neither qualifies while nothing is happening in them.
  expect(envServing(database).length == 0);

  expect(envMarkAgent(database, onlyEnv("t1"), "c17", 0) == "");
  let swept = envServing(database);
  expect(swept.length == 1);
  expect(swept[0].threadId == "t1");
  expect(swept[0].servePort == 0);
  expect(swept[0].agentConn == "c17");

  // And stops qualifying when the daemon goes, because then nothing inside is
  // writing files.
  expect(envMarkAgent(database, onlyEnv("t1"), "", 0) == "");
  expect(envServing(database).length == 0);
});

test("a published port still qualifies, and qualifies once", () => {
  fresh();
  envBindOverride("127.0.0.1");
  dockerServing("49154");
  expect(envEnsure(database, { threadId: "t1", name: "web", image: "node:22",
    network: true, serve: true, command: "npm run dev", start: true, agent: false, now: "1000" }).ok);

  expect(envServing(database).length == 1);
  // Serving AND delegated is one row in one sweep: two selectors would sweep it
  // twice at once, each pass moving the stamp the other compares against.
  expect(envMarkAgent(database, onlyEnv("t1"), "c17", 0) == "");
  expect(envServing(database).length == 1);
  envBindOverride("");
});

test("the idle sweep steps over an environment with a turn running in it", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  ensure("t2", "main", "python:3.12-slim", "1700000000000");
  // A delegated turn is one ensure and then however long the work takes, so
  // lastUsedAt on t1 is as stale as t2's.
  expect(envMarkAgent(database, onlyEnv("t1"), "c17", 512) == "");
  clearLog();

  expect(sweep("1700000900001", ENV_IDLE_MS) == 1);

  let asked = argvLines();
  expect(asked.length == 1);
  expect(asked[0] == "stop agents-env-t2-main");
  expect(onlyEnv("t1").status == "running");
  expect(onlyEnv("t1").agentConn == "c17");
  expect(onlyEnv("t2").status == "stopped");
});

test("a container that came back has neither the daemon nor the log it had", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  expect(envMarkAgent(database, onlyEnv("t1"), "c17", 512) == "");

  // Stopped from outside, then asked for again. joule clears its inbox and
  // truncates broadcast.log on startup, so both columns go back to nothing.
  dockerStoppedBehindOurBack();
  let back = ensure("t1", "main", "python:3.12-slim", "1700001000000");
  expect(back.warmed);
  expect(onlyEnv("t1").agentConn == "");
  expect(onlyEnv("t1").agentRead == 0);
});

test("an ensure that only warms a running container leaves its daemon alone", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  expect(envMarkAgent(database, onlyEnv("t1"), "c17", 512) == "");

  let again = ensure("t1", "main", "python:3.12-slim", "1700000005000");
  expect(again.ok);
  expect(!again.created);
  expect(!again.warmed);
  expect(onlyEnv("t1").agentConn == "c17");
  expect(onlyEnv("t1").agentRead == 512);
});

test("the sync mark carries the agent columns across", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  expect(envMarkAgent(database, onlyEnv("t1"), "c17", 512) == "");

  expect(envMarkSynced(database, onlyEnv("t1"), "1700000900") == "");
  expect(onlyEnv("t1").syncAt == "1700000900");
  expect(onlyEnv("t1").agentConn == "c17");
  expect(onlyEnv("t1").agentRead == 512);
});

// The seccomp deviation, and its blast radius. It is temporary — see the
// comment in envRunArgs and
// https://github.com/joule-sh/code/issues/348#issuecomment-5463608927 — so
// these read as much as they assert: they say exactly what an agent
// environment gets that nothing else does, and that everything else about it
// is unchanged.

function agentEnsure(threadId: string, now: string): EnvEnsured {
  let e: EnvEnsure = { threadId: threadId, name: "joule", image: "agents-joule:1",
    network: true, serve: false, command: "", start: true, agent: true, now: now };
  return envEnsure(database, e);
}

test("only an environment running a daemon is launched unconfined", () => {
  fresh();
  envSeccompOverride("/etc/agents/seccomp.json");
  dockerFine();
  agentEnsure("t1", "1700000000000");
  let agent = argvLines()[1];

  // No async Lumen binary starts under the profile: the runtime brings up an
  // io_uring event loop and io_uring_setup is not on the allowlist, so the
  // daemon aborts before it writes a frame.
  expect(agent.indexOf("--security-opt seccomp=unconfined") > 0);
  expect(agent.indexOf("seccomp=/etc/agents/seccomp.json") < 0);

  // And nothing else is: the profile is a property of the host, not of this
  // decision, and widening it would widen every sandbox on the machine.
  fresh();
  dockerFine();
  ensure("t2", "main", "python:3.12-slim", "1700000000000");
  let plain = argvLines()[0];
  expect(plain.indexOf("seccomp=/etc/agents/seccomp.json") > 0);
  expect(plain.indexOf("unconfined") < 0);
  envSeccompOverride("");
});

test("an unconfined environment is hardened in every other way", () => {
  fresh();
  dockerFine();
  agentEnsure("t1", "1700000000000");
  let made = argvLines()[1];

  expect(made.indexOf("--read-only") > 0);
  expect(made.indexOf("--cap-drop ALL") > 0);
  expect(made.indexOf("--security-opt no-new-privileges") > 0);
  expect(made.indexOf("--tmpfs /tmp:rw,nosuid,size=64m") > 0);
  // Its own network and no published port: the engine reaches the daemon
  // through docker exec and a file, so there is nothing to publish.
  expect(made.indexOf("--network agents-net-t1-joule") > 0);
  expect(made.indexOf(" -p ") < 0);
});

test("a daemon's container keeps its posture when something else rebuilds it", () => {
  fresh();
  dockerFine();
  agentEnsure("t1", "1700000000000");
  expect(envMarkAgent(database, onlyEnv("t1"), "engine-abc", 0) == "");

  // A caller that knows nothing about daemons — the idle sweep's restart, a
  // script asked to run in this environment — finds the container gone and
  // makes it again. The row is what says an agent lives here.
  dockerPruned();
  clearLog();
  let e: EnvEnsure = { threadId: "t1", name: "joule", image: "agents-joule:1",
    network: true, serve: false, command: "", start: true, agent: false, now: "1700001000000" };
  expect(envEnsure(database, e).ok);
  let remade = "";
  let lines = argvLines();
  let i: int = 0;
  while (i < lines.length) {
    if (lines[i].indexOf("run -d --name agents-env-t1-joule") == 0) {
      remade = lines[i];
    }
    i = i + 1;
  }
  expect(remade != "");
  expect(remade.indexOf("seccomp=unconfined") > 0);
});
