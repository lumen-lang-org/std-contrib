import { Db } from "../plume/driver.ts";
import { excerptOf } from "./scan.ts";
import { DbField, DbOrder, DbRepository, field, repository, dialectType, persist, findById, listOrdered, deleteWhere, countWhere, placeholderAt, createTableSql } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { environmentRepository } from "./routes/sandbox/environments/entities/environment.entity.ts";

export const ENV_IDLE_MS: int = 900000;

/** How many environments may hold a network at once. Well under what the
 *  host's address pool allows, so the platform meets a limit it can explain
 *  rather than one docker explains. */
const ENV_LIVE_MAX: int = 200;

/** Who a serving environment runs as, and where its HOME lives. 65534 is
 *  nobody: it owns nothing on the host and nothing in the image. */
const ENV_UID: int = 65534;
const ENV_HOME: string = "/home/sandbox";

/** The two paths a script sandbox is handed on every run. Named here because
 *  they are mounted here and cleared in run-script.ts, and a path spelled
 *  twice is a path that drifts. */
/** A seccomp profile to run sandboxes under, or "" for docker's default.
 *
 *  Read from the environment because the docker CLI resolves this path on the
 *  side it runs on — here, not on the machine the container lands on. That is
 *  the opposite of every other path in this file and cost a puzzled minute. */
export function envSeccompProfile(): string {
  return (process.env("AGENTS_ENV_SECCOMP") ?? "").trim();
}

/** An AppArmor profile for sandboxes, or "" for docker-default.
 *
 *  Loaded on the machine the CONTAINER runs on, which is the sandbox VM — the
 *  opposite of the seccomp profile above, resolved by the docker client here.
 *  Two security options, two different machines, and the error when you get it
 *  the wrong way round names a file rather than a machine. */
export function envApparmorProfile(): string {
  return (process.env("AGENTS_ENV_APPARMOR") ?? "").trim();
}

/** Which container runtime to use, or "" for the daemon's default.
 *
 *  For gVisor: `runsc` puts a user-space kernel between the container and the
 *  host, which is the layer you want the day somebody else's image runs here.
 *  Off unless asked for, because that day has not come — the images are
 *  operator-chosen — and because it costs syscall performance and does not
 *  support io_uring.
 *
 *  The flag is here rather than the runtime, so turning it on is a variable
 *  and a daemon that declares `runsc`, not a change to this file. */
export function envRuntime(): string {
  return (process.env("AGENTS_ENV_RUNTIME") ?? "").trim();
}

export const ENV_RUN_DIR: string = "/artifacts";
export const ENV_SKILLS_DIR: string = "/skills";

export type EnvRow = {
  id: string,
  threadId: string,
  name: string,
  image: string,
  network: int,
  status: string,
  /** The name this environment answers to on the wire: 16 hex characters, one
   *  DNS label, and nothing about the conversation it belongs to. Every
   *  published environment is its own origin, so this is what separates them. */
  slug: string,
  /** The port docker published on the host, or 0 when this environment serves
   *  nothing. Docker picks it, and picks a new one on every restart, which is
   *  why the gateway looks it up rather than remembering it. */
  hostPort: int,
  /** The port inside the container that hostPort reaches. */
  servePort: int,
  /** What to run inside to make it serve. Kept because a container outlives
   *  neither a restart nor a machine, and an environment that comes back with
   *  nothing running in it is serving a port that answers nothing. */
  serveCmd: string,
  /** The container's own clock at the last sync, in epoch seconds. Its clock
   *  and not this one's: the comparison happens over there. */
  syncAt: string,
  /** The connection id the engine writes frames under when a joule daemon is
   *  running inside this environment, and "" when none is.
   *
   *  It is the environment's answer to "is an agent living in here": the
   *  daemon reads `<runtimeDir>/inbox/<agentConn>.in`, so the engine needs the
   *  id to address it at all, and a row that has one is an environment doing
   *  work whether or not it publishes a port. Set when the daemon is started,
   *  cleared when it is stopped — see envMarkAgent, and mind that whoever sets
   *  it owns clearing it, because the idle sweep steps over a row that has
   *  one. */
  agentConn: string,
  /** How many bytes of `<runtimeDir>/broadcast.log` the engine has already
   *  read. The daemon appends one line per outbound frame and never rewrites
   *  what is behind it, so a byte count is the whole cursor.
   *
   *  Reset to 0 whenever the container is recreated: the daemon truncates
   *  broadcast.log at startup, and a cursor kept across that points past the
   *  end of a shorter file. */
  agentRead: int,
  createdAt: string,
  lastUsedAt: string,
};

export function envMapping(): DbRepository {
  return environmentRepository();
}

// The shape migration 64 created, frozen. Building that statement from the
// live mapping instead would mean a fresh database gets every later column at
// CREATE time and then fails the ALTERs that add them, while the databases
// that have been running since 64 still need those ALTERs — the same reason
// runlog keeps a runsMappingV1.
function envMappingV1(): DbRepository {
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
    migration("64", "script environments", createTableSql(db, envMappingV1())),
    migration("116", "an environment may publish a port",
      "ALTER TABLE environments ADD COLUMN host_port " + dialectType(db, "int") + " NOT NULL DEFAULT 0"),
    migration("117", "and says which port inside it that reaches",
      "ALTER TABLE environments ADD COLUMN serve_port " + dialectType(db, "int") + " NOT NULL DEFAULT 0"),
    migration("118", "an environment answers to a name of its own",
      "ALTER TABLE environments ADD COLUMN slug " + db.textType + " NOT NULL DEFAULT ''"),
    // Partial, because every row that predates the column carries '' and a
    // plain unique index would refuse the second one on the way in.
    migration("119", "and no two environments share it",
      "CREATE UNIQUE INDEX IF NOT EXISTS environments_by_slug ON environments (slug) WHERE slug <> ''"),
    migration("122", "an environment remembers what makes it serve",
      "ALTER TABLE environments ADD COLUMN serve_cmd " + db.textType + " NOT NULL DEFAULT ''"),
    migration("123", "and when its workspace was last brought back",
      "ALTER TABLE environments ADD COLUMN sync_at " + db.textType + " NOT NULL DEFAULT ''"),
    migration("142", "an environment may have an agent living in it",
      "ALTER TABLE environments ADD COLUMN agent_conn " + db.textType + " NOT NULL DEFAULT ''"),
    migration("143", "and the engine remembers how much of its log it has read",
      "ALTER TABLE environments ADD COLUMN agent_read " + dialectType(db, "int") + " NOT NULL DEFAULT 0"),
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
  if (envChosenDocker != "") {
    return envChosenDocker;
  }
  return process.env("AGENTS_DOCKER") ?? "docker";
}

function envDocker(args: string[]): EnvDockerReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let reply: EnvDockerReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return reply;
}

function envDockerFault(doing: string, reply: EnvDockerReply): string {
  let detail = envFirstLine(reply.stderr);
  if (detail == "") {
    detail = envFirstLine(reply.stdout);
  }
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
  if (line.length <= ENV_PROBLEM_MAX) {
    return line;
  }
  let cut = ENV_PROBLEM_MAX;
  while (cut > 0 && envContinuation(line.charCodeAt(cut))) {
    cut = cut - 1;
  }
  return excerptOf(line, cut) + "...";
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
    if (fine) {
      out = out + text.charAt(i);
    } else {
      out = out + "-";
    }
    i = i + 1;
  }
  return out;
}

type EnvRun = {
  container: string,
  threadId: string,
  /** Carried alongside the container name because the network is named from
   *  the same pair, and deriving one from the other would be a second place
   *  the naming could drift. */
  name: string,
  image: string,
  network: bool,
  serve: bool,
};

type EnvKeep = {
  threadId: string,
  name: string,
  image: string,
  network: bool,
  status: string,
  slug: string,
  hostPort: int,
  servePort: int,
  serveCmd: string,
  syncAt: string,
  agentConn: string,
  agentRead: int,
  createdAt: string,
  lastUsedAt: string,
};

export type EnvEnsure = {
  threadId: string,
  name: string,
  image: string,
  network: bool,
  /** Publish a port, so the gateway can reach a server running inside. A
   *  published environment is a networked one: docker will not publish a port
   *  from a container that has no network at all. */
  serve: bool,
  /** The command that makes it serve, run when the container is made and
   *  again whenever it comes back. Empty leaves the container idle. */
  command: string,
  /** Whether to run it now. A caller that is about to fill the workspace asks
   *  for the container without starting anything, fills it, then asks again —
   *  otherwise the command runs against an empty directory, fails, and its
   *  death races the start that would have worked. */
  start: bool,
  now: string,
};

export type EnvEnsured = {
  ok: bool,
  container: string,
  created: bool,
  warmed: bool,
  slug: string,
  hostPort: int,
  /** Whether something inside is listening yet. A project that is still
   *  installing is running and answering nothing, which is not a failure. */
  answering: bool,
  fault: string,
};

function envRefused(fault: string): EnvEnsured {
  let r: EnvEnsured = {
    ok: false, container: "", created: false, warmed: false, slug: "", hostPort: 0,
    answering: false, fault: fault,
  };
  return r;
}

export function envEnsure(db: Db, e: EnvEnsure): EnvEnsured {
  if (e.threadId == "") {
    return envRefused("an environment belongs to a conversation, and this call names none");
  }
  if (e.serve && !e.network) {
    return envRefused("an environment that serves a port needs a network: docker publishes no port from a container that has none");
  }
  if (e.serve && envBindAddr() == "") {
    return envRefused("this deployment publishes no environment ports — set AGENTS_ENV_BIND to the one address the gateway reaches, never 0.0.0.0");
  }
  let name = e.name == "" ? "main" : e.name;
  let container = envContainerName(e.threadId, name);
  let held = findById(db, envMapping(), e.threadId + ":" + name);

  if (held == "") {
    if (e.image == "") {
      return envRefused("an environment needs an image to build its container from");
    }
    // Growth is what the cap is for. An environment that already exists may
    // always come back, because refusing to warm one somebody is looking at
    // is worse than the crowding it adds.
    if (e.network || e.serve) {
      let live = envLive(db);
      if (live >= ENV_LIVE_MAX) {
        return envRefused("this deployment is at its limit of " + `${ENV_LIVE_MAX}`
          + " live environments. They release their networks when they go idle, so a new one"
          + " can be made again shortly.");
      }
    }
    let make: EnvRun = {
      container: container, threadId: e.threadId, name: name, image: e.image,
      network: e.network, serve: e.serve,
    };
    let made = envMake(make);
    if (made.status != 0) {
      return envRefused(envMakeFault("create the environment", made));
    }
    if (e.start) {
      envStart(container, e.command);
    }
    let opened = e.serve ? envPublished(container) : 0;
    if (opened != 0) {
      envForward(opened, envForwardHost());
    }
    let slug = envSlugNew();
    let kept = envSave(db, {
      threadId: e.threadId, name: name, image: e.image, network: e.network,
      status: "running", slug: slug,
      hostPort: opened, servePort: e.serve ? envServePort() : 0,
      serveCmd: e.command, syncAt: "",
      // A container just made has no daemon in it and no log to have read.
      agentConn: "", agentRead: 0,
      createdAt: e.now, lastUsedAt: e.now,
    });
    if (kept != "") {
      // The container is up, and unrecorded it is unreachable and unsweepable.
      // Taken down again rather than left behind: an environment nobody can
      // name is worse than one that has to be asked for twice.
      envDocker(["rm", "-f", container]);
      envNetworkDown(e.threadId, name);
      return envRefused("the environment started but could not be written down, so it "
        + "was taken down again: " + kept);
    }
    let fresh: EnvEnsured = {
      ok: true,
      container: container,
      created: true,
      warmed: false,
      slug: slug,
      hostPort: opened,
      answering: e.serve && envAnswering(opened),
      fault: "",
    };
    return fresh;
  }

  let row = JSON.parse<EnvRow>(held);
  let serves = e.serve || row.servePort != 0;
  let make: EnvRun = {
    container: container, threadId: e.threadId, name: row.name, image: row.image,
    network: row.network != 0 || serves, serve: serves,
  };
  let created = false;
  let warmed = false;
  // A port binding is fixed when the container is made, so an environment built
  // without one cannot be handed a port: it is rebuilt instead. The workspace
  // is a volume and survives that.
  if (e.serve && row.servePort == 0) {
    envDocker(["rm", "-f", container]);
    let rebuilt = envMake(make);
    // A rebuild that failed is only a failure if the container is not there
    // afterwards. Several ensures for one environment overlap constantly —
    // the console polls serve every few seconds while one is coming up — and
    // the loser of that race would otherwise report a conflict it caused.
    if (rebuilt.status != 0 && !envRunning(container)) {
      return envRefused(envMakeFault("rebuild the environment so it can serve", rebuilt));
    }
    created = true;
  } else if (!envRunning(container)) {
    // A stopped container remembers the NAME of its network, not the network,
    // and the idle sweep took that away. Made again before the start rather
    // than after the failure, which arrives as a container that cannot set up
    // networking and says nothing about why.
    if (make.network) {
      let up = envNetworkUp(e.threadId, row.name);
      if (up.status != 0) {
        return envRefused(envMakeFault("start the environment", up));
      }
    }
    let started = envDocker(["start", container]);
    if (started.status == 0) {
      warmed = true;
    } else if (envRunning(container)) {
      // It came up between the question and the answer, which is another
      // ensure finishing rather than anything being wrong.
      warmed = true;
    } else {
      envDocker(["rm", "-f", container]);
      let remade = envMake(make);
      if (remade.status != 0 && !envRunning(container)) {
        return envRefused(envMakeFault("start the environment", remade));
      }
      created = true;
    }
  }
  // Asked rather than remembered: docker hands out a fresh ephemeral port on
  // every start, and the probe below reaches the container through this.
  let opened = serves ? envPublished(container) : 0;
  // The port moved, so the forward carrying the old one carries nothing.
  if (row.hostPort != 0 && row.hostPort != opened) {
    envUnforward(row.hostPort);
  }
  if (opened != 0) {
    envForward(opened, envForwardHost());
  }
  let command = e.command != "" ? e.command : row.serveCmd;
  // Not created-or-warmed: a container restarted behind this process's back is
  // running and empty, which that test reads as healthy.
  if (e.start && command != "" && (created || warmed || !envAnswering(opened))) {
    envStart(container, command);
  }
  // Rows made before environments had names of their own get one here, rather
  // than in a migration that would have to invent randomness in SQL.
  let slug = row.slug == "" ? envSlugNew() : row.slug;
  // A container that was made again, or started again, has neither the daemon
  // that was running in it nor the log it was writing: joule truncates
  // broadcast.log at startup and clears its inbox, so a connection id and a
  // byte cursor carried across either of those describe a file that is gone.
  let fromScratch = created || warmed;
  let kept = envSave(db, {
    threadId: row.threadId, name: row.name, image: row.image,
    network: row.network != 0 || serves, status: "running", slug: slug,
    hostPort: opened, servePort: serves ? envServePort() : 0,
    serveCmd: command, syncAt: row.syncAt,
    agentConn: fromScratch ? "" : row.agentConn,
    agentRead: fromScratch ? 0 : row.agentRead,
    createdAt: row.createdAt, lastUsedAt: e.now,
  });
  if (kept != "") {
    // Not taken down: this container was already there and the row still
    // describes it, only with an older port. Said, and the caller decides.
    return envRefused("the environment is running, but where it is now could not be "
      + "written down: " + kept);
  }
  let back: EnvEnsured = {
    ok: true,
    container: container,
    created: created,
    warmed: warmed,
    slug: slug,
    hostPort: opened,
    answering: serves && envAnswering(opened),
    fault: "",
  };
  return back;
}

/** Run what makes an environment serve. Only ever called when the container
 *  was just made or just started, which is precisely when nothing is running
 *  inside it — calling it on every ensure would stack a second server on a port
 *  the first one holds. */
function envStart(container: string, command: string): void {
  if (command == "") {
    return;
  }
  envDocker(["exec", "-d", container, "sh", "-lc", command]);
}

/** Whether anything is listening yet, asked from here rather than inside.
 *
 *  The first version ran nc, /dev/tcp or ss in the container, and a slim Node
 *  image has none of the three — its sh is dash, where /dev/tcp is not a thing.
 *  So it answered "no" for a server that was serving perfectly, and every
 *  ensure started a second copy on a port the first one held. This asks the way
 *  the gateway does: through the forward, from this host. Any answer counts,
 *  404 included — the question is whether something is on the port. */
let envProbeChosen: string = "";

export function envProbeOverride(bin: string): void {
  envProbeChosen = bin;
}

function envProbeBin(): string {
  return envProbeChosen != "" ? envProbeChosen : "curl";
}

function envAnswering(port: int): bool {
  if (port == 0) {
    return false;
  }
  let where = envReachAddr();
  if (where == "") {
    return false;
  }
  let asked = child_process.spawnSync(envProbeBin(),
    ["-s", "-o", "/dev/null", "-m", "2", "http://" + where + ":" + `${port}` + "/"]);
  return asked.status == 0;
}

function envRunning(container: string): bool {
  let seen = envDocker(["inspect", "-f", "{{.State.Running}}", container]);
  if (seen.status != 0) {
    return false;
  }
  return envFirstLine(seen.stdout).trim() == "true";
}

/** Sixteen hex characters: one DNS label, no dashes to lose, and nothing in it
 *  that says which conversation or which person this environment belongs to. */
function envSlugNew(): string {
  let raw = crypto.randomUUID();
  let out = "";
  let i: int = 0;
  while (i < raw.length && out.length < 16) {
    let c = raw.charCodeAt(i);
    if ((c >= 48 && c <= 57) || (c >= 97 && c <= 102)) {
      out = out + raw.charAt(i);
    }
    i = i + 1;
  }
  return out;
}

/** The environment a hostname names, or an empty row. The gateway's whole
 *  routing decision starts here. */
export function envBySlug(db: Db, slug: string): EnvRow {
  let none: EnvRow = {
    id: "", threadId: "", name: "", image: "", network: 0, status: "",
    slug: "", hostPort: 0, servePort: 0, serveCmd: "", syncAt: "",
    agentConn: "", agentRead: 0,
    createdAt: "", lastUsedAt: "",
  };
  if (slug == "") {
    return none;
  }
  let keys: DbOrder[] = [{ column: "id" }];
  let listed = listOrdered(db, envMapping(), {
    where: "slug = " + placeholderAt(db, 1),
    args: [slug],
    order: keys,
  });
  if (listed == "" || listed == "[]") {
    return none;
  }
  let rows = JSON.parse<EnvRow[]>(listed);
  return rows.length == 0 ? none : rows[0];
}

/** The row that says this container exists, and where its port is.
 *
 *  Returns why it could not be written, if it could not. The row is the only
 *  record: docker is asked what is running, but nothing else remembers which
 *  conversation a container belongs to, which port was published, or that it
 *  should be swept. A container started and not recorded is a container
 *  nothing will stop, reach or reuse. */
function envSave(db: Db, k: EnvKeep): string {
  let row: EnvRow = {
    id: k.threadId + ":" + k.name, threadId: k.threadId, name: k.name, image: k.image,
    network: k.network ? 1 : 0, status: k.status, slug: k.slug,
    hostPort: k.hostPort, servePort: k.servePort, serveCmd: k.serveCmd,
    syncAt: k.syncAt, agentConn: k.agentConn, agentRead: k.agentRead,
    createdAt: k.createdAt, lastUsedAt: k.lastUsedAt,
  };
  let written = persist(db, envMapping(), JSON.stringify(row));
  if (!written.ok) {
    return written.error;
  }
  return "";
}

export function envWorkspaceVolume(threadId: string): string {
  return "agents-ws-" + envSafeBytes(threadId);
}

/** Where a serving environment keeps HOME.
 *
 *  A volume of its own rather than a corner of /workspace, because /workspace
 *  is the project and everything in it becomes an artifact. npm's cache in
 *  there would be swept back as thousands of files — and, measured, an npm
 *  cache directory sitting in an otherwise empty project is enough for
 *  `npm create vite` to decide the directory is not empty and scaffold
 *  nothing. */
export function envHomeVolume(threadId: string): string {
  return "agents-home-" + envSafeBytes(threadId);
}

/** Where a script sandbox's run directory and its skills live.
 *
 *  Volumes rather than directories on the image, for one measured reason:
 *  `docker cp` refuses every path on a read-only container's rootfs and is
 *  perfectly happy with a volume mounted inside it. run_script copies a run
 *  directory and a skill tree in on every call, so those two paths had to
 *  become volumes before the rootfs could be sealed. The paths themselves do
 *  not move — /skills/<name>/ is in what the model is told. */
export function envRunVolume(threadId: string): string {
  return "agents-run-" + envSafeBytes(threadId);
}

export function envSkillsVolume(threadId: string): string {
  return "agents-skills-" + envSafeBytes(threadId);
}

let envCapMemMbChosen: int = 0;
let envCapCpusChosen: int = 0;
let envCapPidsChosen: int = 0;
export function envCapsOverride(memMb: int, cpus: int, pids: int): void {
  envCapMemMbChosen = memMb;
  envCapCpusChosen = cpus;
  envCapPidsChosen = pids;
}
function envCapMemMb(): int {
  return envCapMemMbChosen > 0 ? envCapMemMbChosen : 1024;
}
function envCapCpus(): int {
  return envCapCpusChosen > 0 ? envCapCpusChosen : 2;
}
function envCapPids(): int {
  return envCapPidsChosen > 0 ? envCapPidsChosen : 256;
}

const ENV_SERVE_PORT: int = 3000;

let envBindChosen: string = "";

export function envBindOverride(addr: string): void {
  envBindChosen = addr;
}

/** The one address a published environment port is bound to, and empty when
 *  this deployment publishes none. Empty is the default on purpose: a
 *  deployment cannot expose a dev server by forgetting to configure this. */
export function envBindAddr(): string {
  let addr = envBindChosen != "" ? envBindChosen : (process.env("AGENTS_ENV_BIND") ?? "").trim();
  // Every interface the sandbox host has includes the public one, which would
  // put a container the model wrote code into on the internet, with the
  // gateway and its whole grant check bypassed. Refused rather than trusted.
  if (addr == "0.0.0.0" || addr == "::" || addr == "*") {
    return "";
  }
  return addr;
}

let envReachChosen: string = "";

export function envReachOverride(addr: string): void {
  envReachChosen = addr;
}

/** The address the gateway uses to get to a published port, which is not always
 *  the address docker bound it to.
 *
 *  Here they differ, and for a reason worth writing down: environments run on
 *  another machine, and the tailnet between the two permits port 22 and nothing
 *  else, so every service on it is reached through an ssh forward bound to this
 *  host's docker bridge. Docker binds on that machine; the gateway arrives on
 *  this one. Defaults to the bind address, which is right when they are the
 *  same machine. */
export function envReachAddr(): string {
  let addr = envReachChosen != "" ? envReachChosen : (process.env("AGENTS_ENV_REACH") ?? "").trim();
  return addr != "" ? addr : envBindAddr();
}

/** The port a serving environment listens on inside its container. One number
 *  for the deployment, so a template can hard-code it and the gateway need not
 *  care which framework is behind it. */
export function envServePort(): int {
  let chosen = envDigits(process.env("AGENTS_ENV_SERVE_PORT") ?? "");
  return chosen > 0 ? chosen : ENV_SERVE_PORT;
}

// Docker chose the host port, so docker is asked what it chose: `docker port`
// answers "100.109.60.43:49154", and answers differently after a restart.
function envPublished(container: string): int {
  let asked = envDocker(["port", container, `${envServePort()}` + "/tcp"]);
  if (asked.status != 0) {
    return 0;
  }
  let line = envFirstLine(asked.stdout);
  let at: int = line.length - 1;
  while (at >= 0 && line.charCodeAt(at) != 58) {
    at = at - 1;
  }
  if (at < 0) {
    return 0;
  }
  return envDigits(line.slice(at + 1));
}

let envForwardChosen: string = "";

export function envForwardOverride(bin: string): void {
  envForwardChosen = bin;
}

function envForwardBin(): string {
  if (envForwardChosen != "") {
    return envForwardChosen;
  }
  return process.env("AGENTS_ENV_SSH") ?? "ssh";
}

/** The machine environments run on, as ssh knows it. Empty when they run here,
 *  in which case there is nothing to carry and no forward to open. */
function envForwardHost(): string {
  let url = (process.env("DOCKER_HOST") ?? "").trim();
  if (!url.startsWith("ssh://")) {
    return "";
  }
  return url.slice(6);
}

/** Carry a published port across to the address the gateway arrives on.
 *
 *  The tailnet between the two machines permits port 22 and nothing else, so a
 *  port over there is reachable here only through an ssh forward. Opening it is
 *  part of publishing: an environment whose port nothing carries is running and
 *  unreachable, which is the most confusing state it could be in.
 *
 *  Idempotent by asking the kernel rather than by remembering: whoever else
 *  holds that address and port, one is enough. */
function envForward(port: int, remote: string): bool {
  if (port == 0 || remote == "") {
    return false;
  }
  let reach = envReachAddr();
  // Never every interface. This forward is the only way in and it should stay
  // that way; ExitOnForwardFailure makes a refused bind a failure rather than a
  // process that sits there forwarding nothing.
  if (reach == "" || reach == "0.0.0.0" || reach == "::" || reach == "*") {
    return false;
  }
  let where = reach + ":" + `${port}`;
  if (envListening(where)) {
    return true;
  }
  let made = child_process.spawnSync(envForwardBin(), envForwardArgs(where, port, remote));
  return made.status == 0;
}

/** Built apart from the spawning so the shape of the forward can be asserted:
 *  which address it binds, which port it carries, and that a refused bind is a
 *  failure rather than a process forwarding nothing. */
export function envForwardArgs(where: string, port: int, remote: string): string[] {
  let args: string[] = [
    "-f", "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ServerAliveInterval=30",
    "-L", where + ":127.0.0.1:" + `${port}`,
    remote,
  ];
  return args;
}

function envListening(where: string): bool {
  let asked = child_process.spawnSync("ss", ["-ltn"]);
  if (asked.status != 0) {
    return false;
  }
  return asked.stdout.indexOf(" " + where + " ") >= 0;
}

/** Close the forward carrying a port that is no longer worth carrying.
 *
 *  Every restart moves the published port, so without this each one leaves an
 *  ssh process and a listening socket behind: after a day of restarts the box
 *  holds a hundred forwards to ports nothing answers on. */
function envUnforward(port: int): bool {
  if (port == 0) {
    return false;
  }
  let reach = envReachAddr();
  if (reach == "") {
    return false;
  }
  let asked = child_process.spawnSync("ss", ["-ltnp"]);
  if (asked.status != 0) {
    return false;
  }
  let pid = envForwardPid(asked.stdout, reach + ":" + `${port}`);
  if (pid == 0) {
    return false;
  }
  let killed = child_process.spawnSync("kill", [`${pid}`]);
  return killed.status == 0;
}

/** The process holding one address, read out of `ss -ltnp`. Written apart from
 *  the killing so the parsing can be tested: killing the wrong pid because a
 *  line was misread is not a mistake worth making twice. */
export function envForwardPid(listing: string, where: string): int {
  let lines = listing.split("\n");
  let i: int = 0;
  while (i < lines.length) {
    let line = lines[i];
    if (line.indexOf(" " + where + " ") >= 0) {
      let at = line.indexOf("pid=");
      if (at >= 0) {
        let from = at + 4;
        let to = from;
        while (to < line.length) {
          let c = line.charCodeAt(to);
          if (c < 48 || c > 57) {
            break;
          }
          to = to + 1;
        }
        return envDigits(line.slice(from, to));
      }
      return 0;
    }
    i = i + 1;
  }
  return 0;
}

function envDigits(text: string): int {
  let trimmed = text.trim();
  if (trimmed == "") {
    return 0;
  }
  let out: int = 0;
  let i: int = 0;
  while (i < trimmed.length) {
    let c = trimmed.charCodeAt(i);
    if (c < 48 || c > 57) {
      return 0;
    }
    out = out * 10 + (c - 48);
    i = i + 1;
  }
  return out;
}

/** The network one environment gets to itself.
 *
 *  Named after the container, because that name is already unique per
 *  conversation and per environment, and because a slug is not decided until
 *  after the container exists. */
export function envNetworkName(threadId: string, name: string): string {
  return "agents-net-" + envSafeBytes(threadId) + "-" + envSafeBytes(name);
}

/** One bridge per environment, so no environment can reach another.
 *
 *  Deliberately NOT `--internal`. That was the first design, and it fails
 *  twice: docker publishes no port from an internal network, so the gateway
 *  cannot reach the dev server at all, and the container has no route out, so
 *  `npm install` cannot run. Both were measured before this was written.
 *
 *  A plain user-defined bridge gives what is actually wanted — docker keeps
 *  traffic between two of them apart, which is the same mechanism that already
 *  keeps Langfuse's compose network out of reach — while publishing and
 *  outbound both keep working. What it does not do is hide the host; that is
 *  the firewall's job, not docker's. */
/** Docker's word for a network that is already there. */
function envNetworkThere(reply: EnvDockerReply): bool {
  return (reply.stderr + reply.stdout).indexOf("already exists") >= 0;
}

/** Docker's word for a host with no address range left to give.
 *
 *  Worth telling apart, because the raw failure surfaces three layers later
 *  as a container whose network is "not found" — a message that reads like a
 *  glitch and invites a retry, when the truth is that nothing will work until
 *  something is released. */
function envPoolFull(reply: EnvDockerReply): bool {
  return (reply.stderr + reply.stdout).indexOf("address pool") >= 0;
}

/** Made on the way up, and answered for. `create` on a network that already
 *  exists is the ordinary case and not a failure; anything else is, and used
 *  to be dropped on the floor. */
function envNetworkUp(threadId: string, name: string): EnvDockerReply {
  let made = envDocker(["network", "create", envNetworkName(threadId, name)]);
  if (made.status != 0 && envNetworkThere(made)) {
    let fine: EnvDockerReply = { status: 0, stdout: "", stderr: "" };
    return fine;
  }
  return made;
}

/** How many environments hold a network at this moment.
 *
 *  Each one is a docker bridge and each bridge takes a subnet, so this is the
 *  number the host's address pool runs out of. */
export function envLive(db: Db): int {
  let live = countWhere(db, envMapping(), "status = " + placeholderAt(db, 1), ["running"]);
  return live < 0 ? 0 : live;
}

/** What to say when an environment could not be made. */
function envMakeFault(doing: string, reply: EnvDockerReply): string {
  if (envPoolFull(reply)) {
    return "this deployment has no room for another environment: docker has no address range"
      + " left to give one. Environments release theirs when they go idle, so this clears on"
      + " its own; there is nothing here worth trying again now.";
  }
  return envDockerFault(doing, reply);
}

function envNetworkDown(threadId: string, name: string): void {
  envDocker(["network", "rm", envNetworkName(threadId, name)]);
}

/** Hand this conversation's volumes to the uid its container runs as.
 *
 *  A fresh volume belongs to root, and the container that will use it has no
 *  root and no CHOWN to fix that with. A throwaway container does it instead —
 *  the only place root touches these volumes, and it is gone before anything
 *  of the model's runs.
 *
 *  Called again after a workspace is materialised, which is the part that is
 *  easy to miss: `docker cp` writes files owned by the image's own user, not
 *  by the uid the container was told to run as, so a project restored from
 *  artifacts arrives readable and not writable. Every install and every edit
 *  after that fails on permissions, which reads as anything but ownership. */
export function envOwnVolumes(threadId: string, image: string): void {
  if (image == "") {
    return;
  }
  envDocker(["run", "--rm", "-u", "0", "--cap-drop", "ALL", "--cap-add", "CHOWN",
    "-v", envWorkspaceVolume(threadId) + ":/workspace",
    "-v", envHomeVolume(threadId) + ":" + ENV_HOME,
    "--entrypoint", "chown", image,
    "-R", `${ENV_UID}` + ":" + `${ENV_UID}`, "/workspace", ENV_HOME]);
}

/** Docker's word for a name somebody else is already holding. */
function envNameTaken(reply: EnvDockerReply): bool {
  return (reply.stderr + reply.stdout).indexOf("already in use") >= 0;
}

function envMake(r: EnvRun): EnvDockerReply {
  if (r.network || r.serve) {
    let up = envNetworkUp(r.threadId, r.name);
    if (up.status != 0) {
      return up;
    }
  }
  if (r.serve) {
    envOwnVolumes(r.threadId, r.image);
  }
  let made = envDocker(envRunArgs(r));
  // Two ensures for one environment can overlap. The console polls serve
  // every few seconds while a container comes up, and a rebuild is not
  // instant, so the second call can find the container gone, fail to start
  // it, and try to create one into the name the first call has just taken.
  //
  // Whoever loses that race asks what is there rather than failing a click:
  // a container already running under this name is the thing that was wanted,
  // and a dead one is cleared out of the way for one more attempt.
  if (made.status != 0 && envNameTaken(made)) {
    if (envRunning(r.container)) {
      let theirs: EnvDockerReply = { status: 0, stdout: r.container, stderr: "" };
      return theirs;
    }
    envDocker(["rm", "-f", r.container]);
    made = envDocker(envRunArgs(r));
  }
  if (made.status == 0 && !r.serve) {
    envDocker(["exec", r.container, "sh", "-c", "mkdir -p /workspace && chown 65534:65534 /workspace"]);
  }
  return made;
}

function envRunArgs(r: EnvRun): string[] {
  let container = r.container;
  let out: string[] = ["run", "-d", "--name", container];
  let runtime = envRuntime();
  if (runtime != "") {
    out.push("--runtime"); out.push(runtime);
  }
  out.push("-v"); out.push(envWorkspaceVolume(r.threadId) + ":/workspace");
  out.push("--memory"); out.push(`${envCapMemMb()}` + "m");
  out.push("--cpus"); out.push(`${envCapCpus()}`);
  out.push("--pids-limit"); out.push(`${envCapPids()}`);
  out.push("--shm-size"); out.push("512m");
  out.push("--security-opt"); out.push("no-new-privileges");
  // Docker's default profile with the syscalls a sandbox has no business
  // making taken out of it — mount, ptrace, unshare, setns, bpf and the
  // module and kexec families. Measured against the real workload first: a
  // vite install and dev server come up unchanged under it.
  let seccomp = envSeccompProfile();
  if (seccomp != "") {
    out.push("--security-opt"); out.push("seccomp=" + seccomp);
  }
  // Path-based, so a fence rather than a wall: it refuses curl, wget and ssh,
  // which the script images ship and the dev image does not. A program that
  // brings its own client walks around it — this is for the stray command.
  let armor = envApparmorProfile();
  if (armor != "") {
    out.push("--security-opt"); out.push("apparmor=" + armor);
  }
  out.push("--cap-drop"); out.push("ALL");
  if (r.serve) {
    // A serving environment is the one exposed on its own hostname, and it is
    // the one hardened first. Nothing here is theoretical: before this, the
    // process ran as root and /usr/bin was writable, so code in a sandbox
    // could replace the node binary in the image it had been given.
    //
    // Read-only holds because everything this path writes goes to a volume:
    // the project to /workspace, HOME to its own. Measured, docker cp refuses
    // a read-only container's *rootfs* but is happy with a volume mounted
    // inside it — which is exactly what materialising a workspace does.
    out.push("--read-only");
    out.push("--tmpfs"); out.push("/tmp:rw,nosuid,size=64m");
    out.push("-v"); out.push(envHomeVolume(r.threadId) + ":" + ENV_HOME);
    out.push("-e"); out.push("HOME=" + ENV_HOME);
    out.push("-e"); out.push("npm_config_cache=" + ENV_HOME + "/.npm");
    out.push("--user"); out.push(`${ENV_UID}` + ":" + `${ENV_UID}`);
  } else {
    // A script sandbox is sealed the same way, and for a stronger reason: the
    // code it runs is written by a model and runs as root. What it still has
    // that a serving environment does not is root and these five capabilities,
    // because a run chowns its own directory and installs its own packages.
    // Taking those away is a separate change with a different blast radius.
    out.push("--read-only");
    out.push("--tmpfs"); out.push("/tmp:rw,nosuid,size=64m");
    out.push("-v"); out.push(envRunVolume(r.threadId) + ":" + ENV_RUN_DIR);
    out.push("-v"); out.push(envSkillsVolume(r.threadId) + ":" + ENV_SKILLS_DIR);
    out.push("-v"); out.push(envHomeVolume(r.threadId) + ":" + ENV_HOME);
    out.push("--cap-add"); out.push("CHOWN");
    out.push("--cap-add"); out.push("DAC_OVERRIDE");
    out.push("--cap-add"); out.push("FOWNER");
    out.push("--cap-add"); out.push("SETUID");
    out.push("--cap-add"); out.push("SETGID");
  }
  // Bound to one address, never to every interface: the gateway is the only
  // thing that should be able to reach a container, and this is where that is
  // decided. `ip::port` asks docker for an ephemeral host port on that address.
  if (r.serve && envBindAddr() != "") {
    out.push("-p");
    out.push(envBindAddr() + "::" + `${envServePort()}`);
  }
  // Its own network, or none at all. Never the default bridge: everything on
  // that bridge can reach everything else on it, which is how one
  // conversation's container came to be able to fetch another's page.
  out.push("--network");
  out.push(r.network || r.serve ? envNetworkName(r.threadId, r.name) : "none");
  out.push("--entrypoint"); out.push("sleep");
  out.push(r.image); out.push("infinity");
  return out;
}

/** Networks left behind by something that did not get to tidy up.
 *
 *  The idle sweep hands a network back when it stops an environment, so in
 *  the ordinary run of things this finds nothing. It is here for the
 *  extraordinary one: an engine killed between making a network and making
 *  the container, or rows removed without their docker side. A bridge with
 *  nobody on it still holds a subnet, and a host has a fixed number of those
 *  to give — which is how a deployment comes to refuse every new environment
 *  while looking completely idle.
 *
 *  Safe beside live work because docker refuses to remove a network that has
 *  a container attached. The one window it cannot see is the moment between
 *  a network being made and its container joining it; a run caught there is
 *  refused with a reason and succeeds when asked again.
 */
export function envNetworkReap(db: Db): int {
  let listed = envDocker(["network", "ls", "--filter", "name=agents-net-", "--format", "{{.Name}}"]);
  if (listed.status != 0) {
    return 0;
  }
  let keys: DbOrder[] = [{ column: "id" }];
  let rows = listOrdered(db, envMapping(), {
    where: "status = " + placeholderAt(db, 1),
    args: ["running"],
    order: keys,
  });
  let live: EnvRow[] = rows == "" || rows == "[]" ? [] : JSON.parse<EnvRow[]>(rows);
  let names = listed.stdout.split("\n");
  let gone: int = 0;
  let i: int = 0;
  while (i < names.length) {
    let name = names[i].trim();
    if (name != "" && !envNetworkWanted(live, name)) {
      let dropped = envDocker(["network", "rm", name]);
      if (dropped.status == 0) {
        gone = gone + 1;
      }
    }
    i = i + 1;
  }
  return gone;
}

function envNetworkWanted(live: EnvRow[], network: string): bool {
  let i: int = 0;
  while (i < live.length) {
    if (envNetworkName(live[i].threadId, live[i].name) == network) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

export type EnvSweep = {
  now: string,
  idleMs: int,
};

export function envIdle(db: Db, s: EnvSweep): int {
  let idleMs = s.idleMs > 0 ? s.idleMs : ENV_IDLE_MS;
  let deadline = envMinus(s.now, idleMs);
  if (deadline == "") {
    return 0;
  }
  let keys: DbOrder[] = [{ column: "id" }];
  let listed = listOrdered(db, envMapping(), {
    where: "status = " + placeholderAt(db, 1),
    args: ["running"],
    order: keys,
  });
  if (listed == "" || listed == "[]") {
    return 0;
  }
  let rows = JSON.parse<EnvRow[]>(listed);
  let stopped: int = 0;
  let i: int = 0;
  while (i < rows.length) {
    let row = rows[i];
    // An environment with an agent in it is busy, whatever its last ensure
    // says. lastUsedAt only moves when somebody calls envEnsure, and a
    // delegated turn is one ensure followed by however long the work takes:
    // past fifteen minutes of it the sweep would stop the container out from
    // under a daemon that is still writing files. Reading agentConn is the
    // honest test, because it asks whether anything is running rather than
    // whether anybody has been by lately.
    //
    // The cost is that a leaked agentConn is an environment that never idles,
    // so whoever sets the column owns clearing it — envEnsure clears it on any
    // start or rebuild, which bounds the leak to the life of one container.
    if (row.agentConn != "") {
      i = i + 1;
      continue;
    }
    if (!envStampLess(deadline, row.lastUsedAt)) {
      envDocker(["stop", envContainerName(row.threadId, row.name)]);
      // And the network with it. A bridge takes a subnet whether anything is
      // running on it or not, and the host has a few dozen to give: kept, one
      // conversation's leftovers are enough to stop the next from starting at
      // all. The next ensure makes it again before the container comes back.
      if (row.network != 0 || row.servePort != 0) {
        envNetworkDown(row.threadId, row.name);
      }
      envUnforward(row.hostPort);
      // The published port goes with the container. Leaving the old number in
      // the row would point the gateway at whatever takes that port next.
      let noted = envSave(db, {
        threadId: row.threadId, name: row.name, image: row.image,
        network: row.network != 0, status: "stopped", slug: row.slug,
        hostPort: 0, servePort: row.servePort, serveCmd: row.serveCmd,
        syncAt: row.syncAt,
        // Only rows with no agent reach here, so there is nothing to clear.
        agentConn: "", agentRead: 0,
        createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
      });
      if (noted != "") {
        // The container is stopped either way; what is lost is the row saying
        // so, and the old published port pointing at whatever takes it next.
        console.error("environments: " + row.threadId + ":" + row.name
          + " was stopped but still reads as running — " + noted);
      }
      stopped = stopped + 1;
    }
    i = i + 1;
  }
  return stopped;
}

/** Re-open the forwards for everything already serving.
 *
 *  `ssh -f` daemonizes but stays in this process's cgroup, so a restart of the
 *  engine takes every forward with it and each live environment becomes a name
 *  that answers nothing until something touches it. The port is asked for again
 *  rather than taken from the row: a container that restarted while this
 *  process was down is on a different one. */
export function envReforward(db: Db, now: string): int {
  let keys: DbOrder[] = [{ column: "id" }];
  let listed = listOrdered(db, envMapping(), {
    where: "status = " + placeholderAt(db, 1) + " AND serve_port > 0",
    args: ["running"],
    order: keys,
  });
  if (listed == "" || listed == "[]") {
    return 0;
  }
  let rows = JSON.parse<EnvRow[]>(listed);
  let carried: int = 0;
  let i: int = 0;
  while (i < rows.length) {
    let row = rows[i];
    let container = envContainerName(row.threadId, row.name);
    let opened = envRunning(container) ? envPublished(container) : 0;
    if (opened != 0 && envForward(opened, envForwardHost())) {
      carried = carried + 1;
    }
    if (opened != row.hostPort) {
      let noted = envSave(db, {
        threadId: row.threadId, name: row.name, image: row.image,
        network: row.network != 0, status: opened == 0 ? "stopped" : "running",
        slug: row.slug, hostPort: opened, servePort: row.servePort,
        serveCmd: row.serveCmd, syncAt: row.syncAt,
        // This process restarted, not the container: a container still running
        // still has its daemon and its log, so both are carried across. One
        // that is not running has neither, and is about to be written down as
        // stopped.
        agentConn: opened == 0 ? "" : row.agentConn,
        agentRead: opened == 0 ? 0 : row.agentRead,
        createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
      });
      if (noted != "") {
        console.error("environments: " + row.threadId + ":" + row.name
          + " came back on port " + `${opened}` + ", which could not be written down — "
          + "the gateway will keep sending traffic to " + `${row.hostPort}` + ": " + noted);
      }
    }
    i = i + 1;
  }
  return carried;
}

export function envForget(db: Db, threadId: string): void {
  if (threadId == "") {
    return;
  }
  let rows = envList(db, threadId);
  let i: int = 0;
  while (i < rows.length) {
    envDocker(["rm", "-f", envContainerName(rows[i].threadId, rows[i].name)]);
    envNetworkDown(rows[i].threadId, rows[i].name);
    i = i + 1;
  }
  envDocker(["volume", "rm", "-f", envWorkspaceVolume(threadId)]);
  envDocker(["volume", "rm", "-f", envHomeVolume(threadId)]);
  envDocker(["volume", "rm", "-f", envRunVolume(threadId)]);
  envDocker(["volume", "rm", "-f", envSkillsVolume(threadId)]);
  let cleared = deleteWhere(db, envMapping(), "thread_id = " + placeholderAt(db, 1), [threadId]);
  if (!cleared.ok) {
    console.error("environments: the environments of " + threadId + " were taken down but "
      + "their rows stayed: " + cleared.error);
  }
}

/** Every running environment whose workspace somebody is writing in, whoever
 *  owns it. The workspace sweep runs for the deployment, not for a reader.
 *
 *  Two ways to qualify, because there are two ways for work to be happening
 *  inside a container: a published port, which is a person editing through a
 *  dev server, and an agent connection, which is a daemon editing on its own.
 *  A joule environment publishes nothing — the engine reaches its daemon
 *  through `docker exec` and a file inbox — so on the port alone its files
 *  would never come back.
 *
 *  Widened rather than given a sibling selector on purpose. The sweep's
 *  correctness rests on one reader per row: it takes the container's clock,
 *  finds what is newer, and writes the stamp back. Two selectors feeding two
 *  loops would let a row that qualifies both ways be swept twice at once, each
 *  pass moving the stamp the other is comparing against, and the losing pass
 *  would carry files back that were already versions or skip files that were
 *  not. One predicate cannot race itself. */
export function envServing(db: Db): EnvRow[] {
  let keys: DbOrder[] = [{ column: "id" }];
  let listed = listOrdered(db, envMapping(), {
    where: "status = " + placeholderAt(db, 1) + " AND (serve_port > 0 OR agent_conn <> '')",
    args: ["running"],
    order: keys,
  });
  if (listed == "" || listed == "[]") {
    let none: EnvRow[] = [];
    return none;
  }
  return JSON.parse<EnvRow[]>(listed);
}

/** Record how far a sync got, taking the stamp from the container's own clock.
 *  Written after the copy, never before: a sync-in touches every file it writes
 *  and the next sweep would read its own work back as changes.
 *
 *  Returns why the sync mark could not be written, if it could not: unwritten,
 *  the next sync compares against the older stamp and copies back files it has
 *  already seen. */
export function envMarkSynced(db: Db, row: EnvRow, stamp: string): string {
  if (stamp == "") {
    return "";
  }
  return envSave(db, {
    threadId: row.threadId, name: row.name, image: row.image,
    network: row.network != 0, status: row.status, slug: row.slug,
    hostPort: row.hostPort, servePort: row.servePort, serveCmd: row.serveCmd,
    syncAt: stamp, agentConn: row.agentConn, agentRead: row.agentRead,
    createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
  });
}

/** Write down which daemon is running in this environment and how far its log
 *  has been read. Returns why it could not be written, if it could not.
 *
 *  The one way in for the two agent columns, so the rules that hang off them
 *  are stated once. `conn` is the connection id frames are addressed to, or ""
 *  to say the daemon is gone; `read` is a byte offset into broadcast.log, and
 *  goes back to 0 with the id, because the next daemon truncates that file
 *  before it writes a line to it.
 *
 *  Setting a connection id takes the environment out of the idle sweep's
 *  reach, so clearing it is not tidiness: an id left behind is a container
 *  that runs until its thread is forgotten. */
export function envMarkAgent(db: Db, row: EnvRow, conn: string, read: int): string {
  if (row.id == "") {
    return "";
  }
  return envSave(db, {
    threadId: row.threadId, name: row.name, image: row.image,
    network: row.network != 0, status: row.status, slug: row.slug,
    hostPort: row.hostPort, servePort: row.servePort, serveCmd: row.serveCmd,
    syncAt: row.syncAt,
    agentConn: conn, agentRead: conn == "" ? 0 : read,
    createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
  });
}

export function envList(db: Db, threadId: string): EnvRow[] {
  let keys: DbOrder[] = [{ column: "name" }];
  let listed = listOrdered(db, envMapping(), {
    where: "thread_id = " + placeholderAt(db, 1),
    args: [threadId],
    order: keys,
  });
  if (listed == "" || listed == "[]") {
    let none: EnvRow[] = [];
    return none;
  }
  return JSON.parse<EnvRow[]>(listed);
}

/** One of a conversation's environments by name, or an empty row.
 *
 *  What it serves is a property of the conversation, so whoever is asked to
 *  show it again — a person, or the model through serve_env — reads the
 *  command back rather than inventing a second one. */
export function envNamed(db: Db, threadId: string, name: string): EnvRow {
  let held = envList(db, threadId);
  let i: int = 0;
  while (i < held.length) {
    if (held[i].name == name) {
      return held[i];
    }
    i = i + 1;
  }
  let none: EnvRow = {
    id: "", threadId: "", name: "", image: "", network: 0, status: "",
    slug: "", hostPort: 0, servePort: 0, serveCmd: "", syncAt: "",
    agentConn: "", agentRead: 0,
    createdAt: "", lastUsedAt: "",
  };
  return none;
}

/** Millisecond stamps are decimal strings here, so they are compared by length
 *  and then by digit. Exported because the grants beside this file expire on
 *  the same clock and must not invent a second answer. */
export function envStampLess(a: string, b: string): bool {
  let sa = envStripZeros(a);
  let sb = envStripZeros(b);
  if (sa == "" || sb == "") {
    return sa == "" && sb != "";
  }
  if (sa.length != sb.length) {
    return sa.length < sb.length;
  }
  let i: int = 0;
  while (i < sa.length) {
    let ca = sa.charCodeAt(i);
    let cb = sb.charCodeAt(i);
    if (ca != cb) {
      return ca < cb;
    }
    i = i + 1;
  }
  return false;
}

function envStripZeros(text: string): string {
  if (text == "") {
    return "";
  }
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c < 48 || c > 57) {
      return "";
    }
    i = i + 1;
  }
  let at: int = 0;
  while (at < text.length - 1 && text.charCodeAt(at) == 48) {
    at = at + 1;
  }
  return text.slice(at);
}

function envMinus(now: string, ms: int): string {
  if (ms < 0) {
    return "";
  }
  let taking = `${ms}`;
  let stamp = envStripZeros(now);
  if (stamp == "") {
    return "";
  }
  if (envStampLess(stamp, taking)) {
    return "";
  }
  let out = "";
  let ai: int = stamp.length - 1;
  let bi: int = taking.length - 1;
  let borrow: int = 0;
  while (ai >= 0) {
    let da = stamp.charCodeAt(ai) - 48 - borrow;
    let taken = bi >= 0 ? taking.charCodeAt(bi) - 48 : 0;
    borrow = 0;
    if (da < taken) {
      da = da + 10;
      borrow = 1;
    }
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
  /** Present only when this environment serves: the name it answers to, which
   *  is what the console needs to offer a way in. */
  slug: string,
  serving: bool,
  /** Whether it has a server at all, running or asleep.
   *
   *  Apart from `serving`, which is only true while a port is published: the
   *  idle sweep stops a container after fifteen minutes, and a console that
   *  reads the two as one thing takes the button away rather than offering to
   *  wake it — the conversation still has its app. */
  servable: bool,
  createdAt: string,
  lastUsedAt: string,
};

export function envOwned(db: Db, owner: string): EnvOwnedRow[] {
  let out: EnvOwnedRow[] = [];
  if (!db.query(
    "SELECT e.thread_id, t.title, e.name, e.image, e.status, e.created_at, e.last_used_at, e.slug, e.host_port, e.serve_port"
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
      slug: db.value(i, 7),
      // A row can be running and serving nothing: publishing a port is a
      // separate decision, and only a published one has a way in to offer.
      serving: envDigits(db.value(i, 8)) != 0,
      servable: envDigits(db.value(i, 9)) != 0,
    };
    out.push(row);
    i = i + 1;
  }
  return out;
}

export function envDrop(db: Db, threadId: string, name: string): bool {
  let held = findById(db, envMapping(), threadId + ":" + name);
  if (held == "") {
    return false;
  }
  envDocker(["rm", "-f", envContainerName(threadId, name)]);
  // The network goes with the container that was the only thing on it. A
  // network per environment means a leaked network per environment otherwise,
  // and docker's address pool is not endless.
  envNetworkDown(threadId, name);
  let cleared = deleteWhere(db, envMapping(), "id = " + placeholderAt(db, 1), [threadId + ":" + name]);
  if (!cleared.ok) {
    // The container is gone; the row saying it is there is not. Reported as
    // not dropped, because the environment is still listed and still named,
    // and answering "removed" would be a removal the next GET contradicts.
    console.error("environments: " + threadId + ":" + name + " was taken down but its row "
      + "stayed: " + cleared.error);
    return false;
  }
  if (envList(db, threadId).length == 0) {
    envDocker(["volume", "rm", "-f", envWorkspaceVolume(threadId)]);
    envDocker(["volume", "rm", "-f", envHomeVolume(threadId)]);
    envDocker(["volume", "rm", "-f", envRunVolume(threadId)]);
    envDocker(["volume", "rm", "-f", envSkillsVolume(threadId)]);
  }
  return true;
}

export function envImagePresent(image: string): bool {
  if (image == "") {
    return false;
  }
  let asked = envDocker(["image", "inspect", "--format", "held", image]);
  return asked.status == 0;
}
