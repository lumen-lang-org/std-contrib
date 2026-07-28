// Where a conversation's scripts live: one Docker container per environment,
// created the first time the conversation runs something and never before.
//
// This is slice 2 of RUN-SCRIPT.md — the table and the lifecycle, nothing
// else. A chat-only thread has no row here and costs nothing. The first
// `run_script` call makes the row and the container together; idle past a
// deadline the container is stopped (it costs disk, not CPU); the next call
// starts it again; a deleted thread deletes its environments. Everything the
// container holds between runs is cache — the artifacts in Postgres are the
// record — so `docker rm -f` here can never lose work.
//
// Every docker invocation goes through `envDocker`, which is `spawnSync` with
// an argument vector and never a shell string: nothing here can be quoted
// into. The binary comes from `envDockerBin` — the env var AGENTS_DOCKER, or
// "docker" — and a test points that at a fake script instead of the daemon.
//
//   cd packages/agents && lumen test environments.test.ts

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, asc, persist, findById, listOrdered, deleteWhere, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

// How long an environment may sit unused before the sweep stops its
// container: fifteen minutes. What `envIdle` uses when the sweep asks for
// nothing in particular.
export const ENV_IDLE_MS: int = 900000;

// One environment: a named container belonging to one conversation.
//
// The id is derived — thread, colon, name — never random. That is what makes
// (thread_id, name) unique: two creates racing on the same name collapse onto
// one primary key instead of minting two rows, exactly the way an artifact's
// id is its thread and path. `network` is 0 or 1 rather than a bool because
// it is a creation-time property this slice always writes as 0; the column
// exists now so turning it on later is a row value, not a migration.
export type EnvRow = {
  id: string,
  threadId: string,
  name: string,
  image: string,
  network: int,
  status: string,
  createdAt: string,
  lastUsedAt: string,
};

// Frozen the day this ships: migration 64 generates its CREATE from this
// mapping, and a migration's recorded SQL is checksummed and must stay
// byte-identical forever. A new column arrives as an ALTER at a new version
// plus a private copy of this list for the CREATE to keep using — never an
// edit here. The same rule, for the same reason, as artifactsMapping.
export function envMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("threadId", "thread_id", "text"),
    field("name", "name", "text"),
    field("image", "image", "text"),
    field("network", "network", "int"),
    field("status", "status", "text"),
    field("createdAt", "created_at", "text"),
    field("lastUsedAt", "last_used_at", "text"),
  ];
  return repository("environments", "id", "id", fs);
}

export function envPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("64", "script environments", createTableSql(db, envMapping())),
  ];
  return plan;
}

// --- docker ---------------------------------------------------------------------

export type EnvDockerReply = {
  status: int,
  stdout: string,
  stderr: string,
};

// Tests cannot set an environment variable from inside the process — the
// stdlib reads env, it does not write it — so the override is a module-level
// setting the test flips instead. Production never calls it, and an empty
// override means "read AGENTS_DOCKER".
let envChosenDocker: string = "";

export function envDockerOverride(bin: string): void {
  envChosenDocker = bin;
}

export function envDockerBin(): string {
  if (envChosenDocker != "") { return envChosenDocker; }
  return process.env("AGENTS_DOCKER") ?? "docker";
}

// The one door to docker. An argument vector, never a shell string, so a
// thread id or environment name can never be quoted into a command — and
// `spawnSync` reports a binary it could not run as status -1 rather than
// throwing, so a broken docker is an answer here, never an exception.
function envDocker(args: string[]): EnvDockerReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let reply: EnvDockerReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return reply;
}

// The sentence a failed docker call becomes. The first line of stderr is
// usually the daemon's whole explanation ("No such container", "Cannot
// connect to the Docker daemon"), so it is worth carrying — capped, cut on a
// character boundary, because it goes into a reply a model reads.
function envDockerProblem(doing: string, reply: EnvDockerReply): string {
  let detail = envFirstLine(reply.stderr);
  if (detail == "") { detail = envFirstLine(reply.stdout); }
  if (detail == "") {
    return "docker could not " + doing + " (docker itself did not run)";
  }
  return "docker could not " + doing + ": " + detail;
}

// How much of a docker error is worth repeating. Bytes of UTF-8, like every
// cap in this package.
const ENV_PROBLEM_MAX: int = 200;

function envFirstLine(text: string): string {
  let end: int = 0;
  while (end < text.length && text.charCodeAt(end) != 10 && text.charCodeAt(end) != 13) {
    end = end + 1;
  }
  let line = text.slice(0, end).trim();
  if (line.length <= ENV_PROBLEM_MAX) { return line; }
  // Walk back off any continuation byte so the cut never leaves half a
  // character — the same care argsPreview takes, for the same reason.
  let cut = ENV_PROBLEM_MAX;
  while (cut > 0 && envContinuation(line.charCodeAt(cut))) { cut = cut - 1; }
  return line.slice(0, cut) + "...";
}

function envContinuation(b: int): bool {
  return b >= 128 && b < 192;
}

// --- naming ---------------------------------------------------------------------

// The container a (thread, name) pair owns. Docker accepts
// [a-zA-Z0-9][a-zA-Z0-9_.-]* and nothing else, so every byte outside that set
// becomes a dash — a hand-written byte walk, one dash per byte, so a
// multi-byte character becomes as many dashes as it has bytes and the result
// is still deterministic. The fixed prefix keeps the first byte legal and
// makes every container this package owns findable by eye in `docker ps`.
//
// Sanitising can collide — "a b" and "a-b" share a container name — but the
// row's identity is the raw name, and the tool layer validates names before
// they get here, so a collision is a refused `docker run`, not crossed wires.
export function envContainerName(threadId: string, name: string): string {
  return "agents-env-" + envSafeBytes(threadId) + "-" + envSafeBytes(name);
}

function envSafeBytes(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    let fine = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c == 45 || c == 46 || c == 95;
    if (fine) { out = out + text.charAt(i); } else { out = out + "-"; }
    i = i + 1;
  }
  return out;
}

// --- ensure ---------------------------------------------------------------------

export type EnvEnsure = {
  threadId: string,
  name: string,
  image: string,
  // Whether the container may reach out. Read at creation only: an existing
  // environment keeps whatever its row says.
  network: bool,
  now: string,
};

export type EnvEnsured = {
  ok: bool,
  // The container's name, which is the only handle later slices need — every
  // docker verb accepts it where an id would go.
  container: string,
  // A container was created — first use, or a recreation after the old one
  // was pruned. When it is a recreation the workspace cache is gone and the
  // caller's reply should say so; the artifacts were never in it.
  created: bool,
  // A stopped container was started again.
  warmed: bool,
  problem: string,
};

function envRefused(problem: string): EnvEnsured {
  let r: EnvEnsured = { ok: false, container: "", created: false, warmed: false, problem: problem };
  return r;
}

// The row and the container, created on first use. This is the only door:
// there is no separate "create an environment" call, because the agent
// deciding to run something is the decision, and RUN-SCRIPT.md wants no other
// way to make one.
//
// An empty name means "main", matching the tool's contract. The image and the
// network setting are creation-time properties: once the row exists the
// caller's image is ignored, and network stays whatever the row says. The
// decision (2026-07-28): environments have the network, because the point of
// a persistent container is what a script installs into it and an installer
// with nowhere to fetch from is decoration. The row records it; a script can
// never flip it.
export function envEnsure(db: Db, e: EnvEnsure): EnvEnsured {
  if (e.threadId == "") {
    return envRefused("an environment belongs to a conversation, and this call names none");
  }
  let name = e.name == "" ? "main" : e.name;
  let container = envContainerName(e.threadId, name);
  let held = findById(db, envMapping(), e.threadId + ":" + name);

  if (held == "") {
    if (e.image == "") {
      return envRefused("an environment needs an image to build its container from");
    }
    // `sleep infinity` is the container's whole process: something for docker
    // to keep alive between runs, so `docker start` has a thing to start.
    // Scripts arrive later as execs, not as the entrypoint.
    let made = envDocker(envRunArgs(container, e.image, e.network));
    if (made.status != 0) {
      return envRefused(envDockerProblem("create the environment", made));
    }
    // A writable home, owned by the run user. Installs land here — pip and
    // npm both respect HOME — and here is inside the container, so what a
    // script installs persists between runs and dies with the environment.
    envDocker(["exec", container, "sh", "-c", "mkdir -p /workspace && chown 65534:65534 /workspace"]);
    envSave(db, e.threadId, name, e.image, e.network, "running", e.now, e.now);
    let fresh: EnvEnsured = { ok: true, container: container, created: true, warmed: false, problem: "" };
    return fresh;
  }

  let row = JSON.parse<EnvRow>(held);
  let created = false;
  let warmed = false;
  if (row.status != "running") {
    let started = envDocker(["start", container]);
    if (started.status == 0) {
      warmed = true;
    } else {
      // The container is gone — pruned, or the host was rebuilt. The row is
      // the record and the workspace was only cache, so recreate from the
      // image the row remembers; `created` tells the caller to say the cache
      // was lost.
      let remade = envDocker(envRunArgs(container, row.image, row.network != 0));
      if (remade.status != 0) {
        return envRefused(envDockerProblem("start the environment", remade));
      }
      envDocker(["exec", container, "sh", "-c", "mkdir -p /workspace && chown 65534:65534 /workspace"]);
      created = true;
    }
  }
  envSave(db, row.threadId, row.name, row.image, row.network != 0, "running", row.createdAt, e.now);
  let back: EnvEnsured = { ok: true, container: container, created: created, warmed: warmed, problem: "" };
  return back;
}

// The whole row, written whole: `persist` is an upsert over every column, so
// a partial document would write empty over the rest.
function envSave(db: Db, threadId: string, name: string, image: string, network: bool, status: string, createdAt: string, lastUsedAt: string): void {
  let row: EnvRow = {
    id: threadId + ":" + name, threadId: threadId, name: name, image: image,
    network: network ? 1 : 0, status: status, createdAt: createdAt, lastUsedAt: lastUsedAt,
  };
  persist(db, envMapping(), JSON.stringify(row));
}

// The container, as an environment wants it: detached, named, `sleep infinity`
// as the thing docker keeps alive between runs, and offline only when the
// environment was made that way.
function envRunArgs(container: string, image: string, network: bool): string[] {
  let out: string[] = ["run", "-d", "--name", container];
  // The container is the boundary, so the boundary carries the resource caps:
  // the language field constrains nothing (a python script can shell out and
  // cd wherever it likes, deliberately), and without these a script owned the
  // host's CPU and memory until its wall clock ran out.
  out.push("--memory"); out.push("1g");
  out.push("--cpus"); out.push("2");
  out.push("--pids-limit"); out.push("256");
  // Nothing inside may gain a privilege it did not start with — a setuid
  // binary cannot raise this container, whatever a script installs.
  out.push("--security-opt"); out.push("no-new-privileges");
  // Capabilities: everything off, then back only what the workload genuinely
  // needs. apt and pip write files as other owners (CHOWN, DAC_OVERRIDE,
  // FOWNER) and drop privileges to run maintainer scripts (SETUID, SETGID);
  // proven by running a real apt-get install and pip install under exactly
  // this set. Absent from the list, and never coming back: SYS_ADMIN,
  // NET_ADMIN, NET_RAW, SYS_PTRACE, MKNOD, SYS_MODULE.
  out.push("--cap-drop"); out.push("ALL");
  out.push("--cap-add"); out.push("CHOWN");
  out.push("--cap-add"); out.push("DAC_OVERRIDE");
  out.push("--cap-add"); out.push("FOWNER");
  out.push("--cap-add"); out.push("SETUID");
  out.push("--cap-add"); out.push("SETGID");
  if (!network) { out.push("--network"); out.push("none"); }
  out.push(image); out.push("sleep"); out.push("infinity");
  return out;
}

// --- idle -----------------------------------------------------------------------

export type EnvSweep = {
  now: string,
  idleMs: int,
};

// Stop every container idle past the deadline. Returns how many were stopped.
//
// A `docker stop` that fails is not retried and not fatal: the usual failure
// is a container that is already gone, which is exactly the state the sweep
// wanted, and the row — the record — is marked stopped either way. The next
// `envEnsure` sorts out whichever of start-or-recreate the truth requires.
export function envIdle(db: Db, s: EnvSweep): int {
  // A sweep that names no deadline gets the default one; zero is not a
  // deadline, it is "stop everything the moment it is touched".
  let idleMs = s.idleMs > 0 ? s.idleMs : ENV_IDLE_MS;
  let deadline = envMinus(s.now, idleMs);
  if (deadline == "") { return 0; }
  let keys: DbOrder[] = [asc("id")];
  let listed = listOrdered(db, envMapping(), "status = " + placeholderAt(db, 1), ["running"], keys);
  if (listed == "" || listed == "[]") { return 0; }
  let rows = JSON.parse<EnvRow[]>(listed);
  let stopped: int = 0;
  let i: int = 0;
  while (i < rows.length) {
    let row = rows[i];
    if (!envStampLess(deadline, row.lastUsedAt)) {
      envDocker(["stop", envContainerName(row.threadId, row.name)]);
      envSave(db, row.threadId, row.name, row.image, row.network != 0, "stopped", row.createdAt, row.lastUsedAt);
      stopped = stopped + 1;
    }
    i = i + 1;
  }
  return stopped;
}

// --- forget ---------------------------------------------------------------------

// A deleted conversation deletes its environments: containers first, then
// rows. `rm -f` on a container that is already gone fails, and that failure
// is ignored for the same reason the sweep ignores it — gone is the goal.
export function envForget(db: Db, threadId: string): void {
  if (threadId == "") { return; }
  let rows = envList(db, threadId);
  let i: int = 0;
  while (i < rows.length) {
    envDocker(["rm", "-f", envContainerName(rows[i].threadId, rows[i].name)]);
    i = i + 1;
  }
  deleteWhere(db, envMapping(), "thread_id = " + placeholderAt(db, 1), [threadId]);
}

export function envList(db: Db, threadId: string): EnvRow[] {
  let keys: DbOrder[] = [asc("name")];
  let listed = listOrdered(db, envMapping(), "thread_id = " + placeholderAt(db, 1), [threadId], keys);
  if (listed == "" || listed == "[]") {
    let none: EnvRow[] = [];
    return none;
  }
  return JSON.parse<EnvRow[]>(listed);
}

// --- stamp arithmetic -----------------------------------------------------------
//
// Timestamps here are millisecond stamps as decimal strings — thirteen digits
// — and `parseInt` answers an i32, which a millisecond stamp overflows. So
// the deadline is computed on the digits themselves: a hand-written decimal
// subtraction and a numeric compare, neither of which ever parses the whole
// number.

// a < b, numerically, for two digit strings. Anything non-numeric compares
// as less than everything, which makes a malformed last_used_at read as
// ancient — the conservative direction for a sweep (stopping a container is
// recoverable; leaving one running forever is the leak).
function envStampLess(a: string, b: string): bool {
  let sa = envStripZeros(a);
  let sb = envStripZeros(b);
  if (sa == "" || sb == "") { return sa == "" && sb != ""; }
  if (sa.length != sb.length) { return sa.length < sb.length; }
  let i: int = 0;
  while (i < sa.length) {
    let ca = sa.charCodeAt(i);
    let cb = sb.charCodeAt(i);
    if (ca != cb) { return ca < cb; }
    i = i + 1;
  }
  return false;
}

// The digits without their leading zeros; "" when the text is not a number.
function envStripZeros(text: string): string {
  if (text == "") { return ""; }
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c < 48 || c > 57) { return ""; }
    i = i + 1;
  }
  let at: int = 0;
  while (at < text.length - 1 && text.charCodeAt(at) == 48) { at = at + 1; }
  return text.slice(at);
}

// now - ms, as a digit string; "" when now is not a number or the result
// would be negative. Schoolbook subtraction, right to left with a borrow,
// because the operands are too wide for the integer the language parses into.
function envMinus(now: string, ms: int): string {
  if (ms < 0) { return ""; }
  let taking = `${ms}`;
  let stamp = envStripZeros(now);
  if (stamp == "") { return ""; }
  if (envStampLess(stamp, taking)) { return ""; }
  let out = "";
  let ai: int = stamp.length - 1;
  let bi: int = taking.length - 1;
  let borrow: int = 0;
  while (ai >= 0) {
    let da = stamp.charCodeAt(ai) - 48 - borrow;
    let taken = bi >= 0 ? taking.charCodeAt(bi) - 48 : 0;
    borrow = 0;
    if (da < taken) { da = da + 10; borrow = 1; }
    out = "0123456789".charAt(da - taken) + out;
    ai = ai - 1;
    bi = bi - 1;
  }
  let trimmed = envStripZeros(out);
  return trimmed == "" ? "0" : trimmed;
}
