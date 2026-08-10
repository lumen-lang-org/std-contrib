import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, field, repository, persist, findById, listOrdered, deleteWhere, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

export const ENV_IDLE_MS: int = 900000;

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
  return repository({ table: "environments", idField: "id", idColumn: "id", fields: fs });
}

export function envPlan(db: Db): Migration[] {
  let plan: Migration[] = [
    migration("64", "script environments", createTableSql(db, envMapping())),
  ];
  return plan;
}

export type EnvDockerReply = {
  status: int,
  stdout: string,
  stderr: string,
};

let envChosenDocker: string = "";

export function envDockerOverride(bin: string): void {
  envChosenDocker = bin;
}

export function envDockerBin(): string {
  if (envChosenDocker != "") { return envChosenDocker; }
  return process.env("AGENTS_DOCKER") ?? "docker";
}

function envDocker(args: string[]): EnvDockerReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let reply: EnvDockerReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return reply;
}

function envDockerProblem(doing: string, reply: EnvDockerReply): string {
  let detail = envFirstLine(reply.stderr);
  if (detail == "") { detail = envFirstLine(reply.stdout); }
  if (detail == "") {
    return "docker could not " + doing + " (docker itself did not run)";
  }
  return "docker could not " + doing + ": " + detail;
}

const ENV_PROBLEM_MAX: int = 200;

function envFirstLine(text: string): string {
  let end: int = 0;
  while (end < text.length && text.charCodeAt(end) != 10 && text.charCodeAt(end) != 13) {
    end = end + 1;
  }
  let line = text.slice(0, end).trim();
  if (line.length <= ENV_PROBLEM_MAX) { return line; }
  let cut = ENV_PROBLEM_MAX;
  while (cut > 0 && envContinuation(line.charCodeAt(cut))) { cut = cut - 1; }
  return line.slice(0, cut) + "...";
}

function envContinuation(b: int): bool {
  return b >= 128 && b < 192;
}

const ENV_DOCKER_ASK_EVERY_MS: int = 5000;

let envDockerAskedAt: string = "";
let envDockerAnswered: bool = false;

export function envDockerUp(now: string): bool {
  let fresh = envMinus(now, ENV_DOCKER_ASK_EVERY_MS);
  if (envDockerAskedAt != "" && fresh != "" && !envStampLess(envDockerAskedAt, fresh)) {
    return envDockerAnswered;
  }
  let asked = envDocker(["version", "--format", "{{.Server.Version}}"]);
  envDockerAnswered = asked.status == 0;
  envDockerAskedAt = now;
  return envDockerAnswered;
}

export function envDockerForget(): void {
  envDockerAskedAt = "";
  envDockerAnswered = false;
}

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

export type EnvEnsure = {
  threadId: string,
  name: string,
  image: string,
  network: bool,
  now: string,
};

export type EnvEnsured = {
  ok: bool,
  container: string,
  created: bool,
  warmed: bool,
  problem: string,
};

function envRefused(problem: string): EnvEnsured {
  let r: EnvEnsured = { ok: false, container: "", created: false, warmed: false, problem: problem };
  return r;
}

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
    let made = envDocker(envRunArgs(container, e.threadId, e.image, e.network));
    if (made.status != 0) {
      return envRefused(envDockerProblem("create the environment", made));
    }
    envDocker(["exec", container, "sh", "-c", "mkdir -p /workspace && chown 65534:65534 /workspace"]);
    envSave(db, e.threadId, name, e.image, e.network, "running", e.now, e.now);
    let fresh: EnvEnsured = { ok: true, container: container, created: true, warmed: false, problem: "" };
    return fresh;
  }

  let row = JSON.parse<EnvRow>(held);
  let created = false;
  let warmed = false;
  if (!envRunning(container)) {
    let started = envDocker(["start", container]);
    if (started.status == 0) {
      warmed = true;
    } else {
      envDocker(["rm", "-f", container]);
      let remade = envDocker(envRunArgs(container, e.threadId, row.image, row.network != 0));
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

function envRunning(container: string): bool {
  let seen = envDocker(["inspect", "-f", "{{.State.Running}}", container]);
  if (seen.status != 0) { return false; }
  return envFirstLine(seen.stdout).trim() == "true";
}

function envSave(db: Db, threadId: string, name: string, image: string, network: bool, status: string, createdAt: string, lastUsedAt: string): void {
  let row: EnvRow = {
    id: threadId + ":" + name, threadId: threadId, name: name, image: image,
    network: network ? 1 : 0, status: status, createdAt: createdAt, lastUsedAt: lastUsedAt,
  };
  persist(db, envMapping(), JSON.stringify(row));
}

export function envWorkspaceVolume(threadId: string): string {
  return "agents-ws-" + envSafeBytes(threadId);
}

let envCapMemMbChosen: int = 0;
let envCapCpusChosen: int = 0;
let envCapPidsChosen: int = 0;
export function envCapsOverride(memMb: int, cpus: int, pids: int): void {
  envCapMemMbChosen = memMb;
  envCapCpusChosen = cpus;
  envCapPidsChosen = pids;
}
function envCapMemMb(): int { return envCapMemMbChosen > 0 ? envCapMemMbChosen : 1024; }
function envCapCpus(): int { return envCapCpusChosen > 0 ? envCapCpusChosen : 2; }
function envCapPids(): int { return envCapPidsChosen > 0 ? envCapPidsChosen : 256; }

function envRunArgs(container: string, threadId: string, image: string, network: bool): string[] {
  let out: string[] = ["run", "-d", "--name", container];
  out.push("-v"); out.push(envWorkspaceVolume(threadId) + ":/workspace");
  out.push("--memory"); out.push(`${envCapMemMb()}` + "m");
  out.push("--cpus"); out.push(`${envCapCpus()}`);
  out.push("--pids-limit"); out.push(`${envCapPids()}`);
  out.push("--shm-size"); out.push("512m");
  out.push("--security-opt"); out.push("no-new-privileges");
  out.push("--cap-drop"); out.push("ALL");
  out.push("--cap-add"); out.push("CHOWN");
  out.push("--cap-add"); out.push("DAC_OVERRIDE");
  out.push("--cap-add"); out.push("FOWNER");
  out.push("--cap-add"); out.push("SETUID");
  out.push("--cap-add"); out.push("SETGID");
  if (!network) { out.push("--network"); out.push("none"); }
  out.push("--entrypoint"); out.push("sleep");
  out.push(image); out.push("infinity");
  return out;
}

export type EnvSweep = {
  now: string,
  idleMs: int,
};

export function envIdle(db: Db, s: EnvSweep): int {
  let idleMs = s.idleMs > 0 ? s.idleMs : ENV_IDLE_MS;
  let deadline = envMinus(s.now, idleMs);
  if (deadline == "") { return 0; }
  let keys: DbOrder[] = [{ column: "id" }];
  let listed = listOrdered(db, envMapping(), { where: "status = " + placeholderAt(db, 1), args: ["running"], order: keys });
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

export function envForget(db: Db, threadId: string): void {
  if (threadId == "") { return; }
  let rows = envList(db, threadId);
  let i: int = 0;
  while (i < rows.length) {
    envDocker(["rm", "-f", envContainerName(rows[i].threadId, rows[i].name)]);
    i = i + 1;
  }
  envDocker(["volume", "rm", "-f", envWorkspaceVolume(threadId)]);
  deleteWhere(db, envMapping(), "thread_id = " + placeholderAt(db, 1), [threadId]);
}

export function envList(db: Db, threadId: string): EnvRow[] {
  let keys: DbOrder[] = [{ column: "name" }];
  let listed = listOrdered(db, envMapping(), { where: "thread_id = " + placeholderAt(db, 1), args: [threadId], order: keys });
  if (listed == "" || listed == "[]") {
    let none: EnvRow[] = [];
    return none;
  }
  return JSON.parse<EnvRow[]>(listed);
}

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

export type EnvOwnedRow = {
  threadId: string,
  threadTitle: string,
  name: string,
  image: string,
  status: string,
  createdAt: string,
  lastUsedAt: string,
};

export function envOwned(db: Db, owner: string): EnvOwnedRow[] {
  let out: EnvOwnedRow[] = [];
  if (!db.query(
    "SELECT e.thread_id, t.title, e.name, e.image, e.status, e.created_at, e.last_used_at"
      + " FROM environments e JOIN threads t ON t.id = e.thread_id"
      + " WHERE t.owner = " + placeholderAt(db, 1)
      + " ORDER BY e.last_used_at DESC, e.created_at DESC", [owner])) {
    return out;
  }
  let i: int = 0;
  while (i < db.rows()) {
    let row: EnvOwnedRow = {
      threadId: db.value(i, 0),
      threadTitle: db.value(i, 1),
      name: db.value(i, 2),
      image: db.value(i, 3),
      status: db.value(i, 4),
      createdAt: db.value(i, 5),
      lastUsedAt: db.value(i, 6),
    };
    out.push(row);
    i = i + 1;
  }
  return out;
}

export function envDrop(db: Db, threadId: string, name: string): bool {
  let held = findById(db, envMapping(), threadId + ":" + name);
  if (held == "") { return false; }
  envDocker(["rm", "-f", envContainerName(threadId, name)]);
  deleteWhere(db, envMapping(), "id = " + placeholderAt(db, 1), [threadId + ":" + name]);
  if (envList(db, threadId).length == 0) {
    envDocker(["volume", "rm", "-f", envWorkspaceVolume(threadId)]);
  }
  return true;
}

export function envImagePresent(image: string): bool {
  if (image == "") { return false; }
  let asked = envDocker(["image", "inspect", "--format", "held", image]);
  return asked.status == 0;
}
