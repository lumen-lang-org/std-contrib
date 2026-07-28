// The environments table and its containers, with docker played by a shell
// script.
//
// Every docker invocation goes through one door that runs `envDockerBin()`,
// and the tests point that at a fake — a script that appends its argv to a
// log and answers canned output — so what is asserted is exactly what would
// have been asked of the real daemon: which verb, which container name, in
// which order. The override function exists because a Lumen process can read
// its environment but not write it, so AGENTS_DOCKER itself cannot be set
// from inside a test; the fake is what AGENTS_DOCKER would point at.
//
//   cd packages/agents && lumen test environments.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { EnvRow, EnvEnsure, EnvEnsured, EnvSweep, ENV_IDLE_MS, envPlan, envEnsure, envIdle, envForget, envList, envContainerName, envDockerOverride } from "./environments.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_env_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS environments");
  migrate(database, envPlan(database));
}

// --- the fake docker ------------------------------------------------------------

const FAKE_DIR = "/tmp/agents_env_fake";
const FAKE_LOG = "/tmp/agents_env_fake/argv.log";

// Write a shell script, make it executable, point the docker seam at it, and
// start its argv log empty.
function fakeDocker(script: string): void {
  if (!fs.existsSync(FAKE_DIR)) { fs.mkdirSync(FAKE_DIR); }
  let bin = FAKE_DIR + "/docker";
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 493);
  fs.writeFileSync(FAKE_LOG, "");
  envDockerOverride(bin);
}

// A docker that always succeeds, printing a container id for `run` the way
// the real one does.
function dockerFine(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "exit 0\n");
}

// A docker whose daemon is unreachable: everything fails the way the real
// CLI fails, on stderr with a non-zero exit.
function dockerBroken(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "echo \"Cannot connect to the Docker daemon\" >&2\n"
    + "exit 1\n");
}

// A docker that has lost its containers — `start` fails the way it does after
// a prune — but can still `run` new ones.
function dockerPruned(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "if [ \"$1\" = \"start\" ]; then echo \"Error response from daemon: No such container\" >&2; exit 1; fi\n"
    + "if [ \"$1\" = \"run\" ]; then echo c0ffee; fi\n"
    + "exit 0\n");
}

function argvLines(): string[] {
  let held = fs.readFileSync(FAKE_LOG);
  let out: string[] = [];
  let lines = held.split("\n");
  let i: int = 0;
  while (i < lines.length) {
    if (lines[i] != "") { out.push(lines[i]); }
    i = i + 1;
  }
  return out;
}

function clearLog(): void {
  fs.writeFileSync(FAKE_LOG, "");
}

function ensure(threadId: string, name: string, image: string, now: string): EnvEnsured {
  let e: EnvEnsure = { threadId: threadId, name: name, image: image, now: now };
  return envEnsure(database, e);
}

function sweep(now: string, idleMs: int): int {
  let s: EnvSweep = { now: now, idleMs: idleMs };
  return envIdle(database, s);
}

// --- tests ----------------------------------------------------------------------

test("first use creates the container and the row, named main by default", () => {
  fresh();
  dockerFine();
  let made = ensure("t1", "", "python:3.12-slim", "1700000000000");

  expect(made.ok);
  expect(made.created);
  expect(!made.warmed);
  expect(made.container == "agents-env-t1-main");
  expect(made.problem == "");

  // The container was asked for with no network and a process to keep alive.
  let asked = argvLines();
  expect(asked.length == 1);
  expect(asked[0] == "run -d --name agents-env-t1-main --network none python:3.12-slim sleep infinity");

  let rows = envList(database, "t1");
  expect(rows.length == 1);
  expect(rows[0].name == "main");
  expect(rows[0].image == "python:3.12-slim");
  expect(rows[0].status == "running");
  expect(rows[0].network == 0);
  expect(rows[0].lastUsedAt == "1700000000000");
});

test("a second call reuses the running container and asks docker nothing", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  clearLog();

  let again = ensure("t1", "main", "python:3.12-slim", "1700000005000");
  expect(again.ok);
  expect(!again.created);
  expect(!again.warmed);
  expect(argvLines().length == 0);

  // The touch is recorded, so the idle sweep measures from this call.
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

  let back = ensure("t1", "main", "", "1700001000000");
  expect(back.ok);
  expect(back.warmed);
  expect(!back.created);

  let asked = argvLines();
  expect(asked.length == 1);
  expect(asked[0] == "start agents-env-t1-main");

  let rows = envList(database, "t1");
  expect(rows[0].status == "running");
});

test("the idle sweep stops what is past the deadline and keeps what is not", () => {
  fresh();
  dockerFine();
  ensure("t1", "main", "python:3.12-slim", "1700000000000");
  ensure("t2", "main", "python:3.12-slim", "1700000600000");
  clearLog();

  // Deadline is now minus 15 minutes: t1 is exactly on it and stops, t2 is
  // inside it and keeps running.
  expect(sweep("1700000900000", ENV_IDLE_MS) == 1);

  let asked = argvLines();
  expect(asked.length == 1);
  expect(asked[0] == "stop agents-env-t1-main");

  expect(envList(database, "t1")[0].status == "stopped");
  expect(envList(database, "t2")[0].status == "running");
});

test("the deadline arithmetic survives a borrow across every digit", () => {
  // 1000000000000 - 1 is 999999999999: the subtraction borrows through the
  // whole stamp, and parseInt could never have held either side. A row used
  // one millisecond before the deadline stops; a row used on the dot stays.
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
  expect(asked.length == 2);
  expect(asked[0] == "rm -f agents-env-t1-main");
  expect(asked[1] == "rm -f agents-env-t1-web");

  expect(envList(database, "t1").length == 0);
  expect(envList(database, "t2").length == 1);
});

test("container names are docker-legal whatever the thread id holds", () => {
  // A space, a slash, and a two-byte character: each byte outside docker's
  // charset becomes one dash, so the multi-byte character becomes two.
  expect(envContainerName("t 1/x", "wé b") == "agents-env-t-1-x-w---b");
  expect(envContainerName("thread.A_9", "main") == "agents-env-thread.A_9-main");

  // And the sanitised name is what docker is actually asked for.
  fresh();
  dockerFine();
  let made = ensure("t 1/x", "", "python:3.12-slim", "1700000000000");
  expect(made.ok);
  expect(made.container == "agents-env-t-1-x-main");
  let asked = argvLines();
  expect(asked[0] == "run -d --name agents-env-t-1-x-main --network none python:3.12-slim sleep infinity");
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

  // No container means no environment: the row is only minted when the
  // container exists, so a retry after docker recovers starts clean.
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

  // Start was tried first, failed, and the recreate used the image the row
  // remembers — the caller passed none.
  let asked = argvLines();
  expect(asked.length == 2);
  expect(asked[0] == "start agents-env-t1-main");
  expect(asked[1] == "run -d --name agents-env-t1-main --network none python:3.12-slim sleep infinity");

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

  // Neither refusal reached docker or the table.
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
