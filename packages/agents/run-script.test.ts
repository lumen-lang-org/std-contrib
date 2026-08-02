// What the materialise/reconcile pair promises before any container exists:
// the newest version of every named artifact lands in the run directory and
// nothing else does; a run's changes come back through the same validation as
// write_artifact; byte-identical files mint no version; a deletion in the run
// directory never deletes anything; and a version that moved mid-run refuses
// that one path while the rest still land. All against a SQLite temp file and
// a plain directory — no docker, nothing reaches :8100 or the live database.
//
//   cd packages/agents && lumen test run-script.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute, executeWith, placeholderAt } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ARTIFACT_MAX, THREAD_BYTES_MAX, artifactPlan, putArtifact, getArtifact, getVersion } from "./artifacts.ts";
import { ScriptFile, ScriptReconcile, ScriptRun, ScriptRan, scriptMaterialise, scriptReconcile, scriptRun, scriptAcquire, scriptRelease, scriptRunningCount, scriptWallOverride, scriptOutputOverride, scriptProbeReset, scriptDockerWorks, scriptImage, scriptImageFor } from "./run-script.ts";
import { EnvSweep, ENV_IDLE_MS, envPlan, envIdle, envList, envContainerName, envDockerOverride } from "./environments.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_script_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS artifact_versions");
  execute(database, "DROP TABLE IF EXISTS artifacts");
  execute(database, "DROP TABLE IF EXISTS environments");
  let plan = artifactPlan(database);
  let more = envPlan(database);
  let m: int = 0;
  while (m < more.length) { plan.push(more[m]); m = m + 1; }
  migrate(database, plan);
}

// One artifact in thread t1, version 1.
function seeded(path: string, body: string): void {
  putArtifact(database, {
    threadId: "t1", path: path, title: "", content: body,
    note: "first", origin: "generated", mustCreate: false,
    turnSeq: 3, now: "1000",
  });
}

// An empty run directory, recreated per test so nothing leaks between cases.
function runDir(): string {
  let dir = "/tmp/agents_script_test_run";
  if (fs.existsSync(dir)) { fs.rmSync(dir, true); }
  fs.mkdirSync(dir, true);
  return dir;
}

// The reconcile record most cases send: thread t1, a later round, mayCreate off.
function landing(dir: string, snapshot: ScriptFile[], mayCreate: bool): ScriptReconcile {
  let out: ScriptReconcile = {
    threadId: "t1", dir: dir, snapshot: snapshot, mayCreate: mayCreate,
    note: "from a script run", turnSeq: 7, now: "2000",
  };
  return out;
}

// A version row inserted behind the run's back — the concurrent writer the
// version precondition exists for.
function outOfBand(artifactId: string, version: int, body: string): void {
  executeWith(database,
    "INSERT INTO artifact_versions (id, artifact_id, version, body, bytes, origin, turn_seq, note, created_at) VALUES ("
    + placeholderAt(database, 1) + ", " + placeholderAt(database, 2) + ", " + placeholderAt(database, 3) + ", "
    + placeholderAt(database, 4) + ", " + placeholderAt(database, 5) + ", " + placeholderAt(database, 6) + ", "
    + placeholderAt(database, 7) + ", " + placeholderAt(database, 8) + ", " + placeholderAt(database, 9) + ")",
    [artifactId + ":" + `${version}`, artifactId, `${version}`, body, `${body.length}`,
     "generated", "9", "out of band", "1500"]);
}

// n copies of `piece`.
function fill(piece: string, n: int): string {
  let out = "";
  let i: int = 0;
  while (i < n) { out = out + piece; i = i + 1; }
  return out;
}

// --- materialise ------------------------------------------------------------------

test("materialise writes each named path's newest version at its relative path", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  seeded("/reports/q3.md", "quarter\n");
  let dir = runDir();
  let got = scriptMaterialise(database, "t1", ["/notes.md", "/reports/q3.md"], dir);
  expect(got.length == 2);
  expect(got[0].ok);
  expect(got[0].version == 1);
  expect(got[1].ok);
  expect(fs.readFileSync(dir + "/notes.md") == "alpha\n");
  // The parent directory was created on the way.
  expect(fs.readFileSync(dir + "/reports/q3.md") == "quarter\n");
});

test("materialise writes the newest version, not the first", () => {
  fresh();
  seeded("/notes.md", "old\n");
  putArtifact(database, {
    threadId: "t1", path: "/notes.md", title: "", content: "new\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 4, now: "1100",
  });
  let dir = runDir();
  let got = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  expect(got[0].ok);
  expect(got[0].version == 2);
  expect(fs.readFileSync(dir + "/notes.md") == "new\n");
});

test("a path that is not an artifact of this thread is refused by name, and no file appears", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let got = scriptMaterialise(database, "t1", ["/notes.md", "/ghost.md"], dir);
  expect(got.length == 2);
  expect(got[0].ok);
  expect(!got[1].ok);
  expect(got[1].problem.indexOf("/ghost.md") >= 0);
  expect(!fs.existsSync(dir + "/ghost.md"));
  // The known path still landed: refusal is per path, the caller decides
  // whether the run proceeds.
  expect(fs.existsSync(dir + "/notes.md"));
});

test("another thread's artifact is not this thread's", () => {
  fresh();
  putArtifact(database, {
    threadId: "t2", path: "/theirs.md", title: "", content: "secret\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let dir = runDir();
  let got = scriptMaterialise(database, "t1", ["/theirs.md"], dir);
  expect(!got[0].ok);
  expect(got[0].problem.indexOf("/theirs.md") >= 0);
  expect(!fs.existsSync(dir + "/theirs.md"));
});

// --- reconcile: the quiet cases ---------------------------------------------------

test("a byte-identical file mints no version", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.unchanged.length == 1);
  expect(done.unchanged[0].path == "/notes.md");
  expect(done.unchanged[0].version == 1);
  expect(done.changed.length == 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
  expect(getVersion(database, "t1:/notes.md", 2).id == "");
});

test("a changed file appends the next version exactly as write_artifact would", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  fs.writeFileSync(dir + "/notes.md", "alpha\nbeta\n");
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.changed.length == 1);
  expect(done.changed[0].path == "/notes.md");
  expect(done.changed[0].version == 2);
  // The log is append-only: version 1 untouched, version 2 the file's bytes.
  expect(getVersion(database, "t1:/notes.md", 1).body == "alpha\n");
  let row = getVersion(database, "t1:/notes.md", 2);
  expect(row.body == "alpha\nbeta\n");
  expect(row.origin == "generated");
  expect(row.turnSeq == 7);
  expect(row.note == "from a script run");
  // The pointer moved with it.
  let after = getArtifact(database, "t1", "/notes.md");
  expect(after.currentVersion == 2);
  expect(after.updatedAt == "2000");
});

test("a changed file moves only the pointer's version and date, never its metadata", () => {
  fresh();
  putArtifact(database, {
    threadId: "t1", path: "/notes.md", title: "Notes", content: "alpha\n",
    note: "", origin: "generated", mustCreate: false, turnSeq: 3, now: "1000",
  });
  let before = getArtifact(database, "t1", "/notes.md");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  fs.writeFileSync(dir + "/notes.md", "beta\n");
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  let after = getArtifact(database, "t1", "/notes.md");
  expect(after.slot == before.slot);
  expect(after.title == before.title);
  expect(after.previewToken == before.previewToken);
  expect(after.createdAt == before.createdAt);
});

test("a nested path reconciles at its nested path", () => {
  fresh();
  seeded("/reports/q3.md", "quarter\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/reports/q3.md"], dir);
  fs.writeFileSync(dir + "/reports/q3.md", "quarter, revised\n");
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.changed.length == 1);
  expect(done.changed[0].path == "/reports/q3.md");
  expect(getVersion(database, "t1:/reports/q3.md", 2).body == "quarter, revised\n");
});

// --- reconcile: deletion never propagates -----------------------------------------

test("a file deleted in the run directory is reported, and the artifact is untouched", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  fs.rmSync(dir + "/notes.md", false);
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.missing.length == 1);
  expect(done.missing[0] == "/notes.md");
  expect(done.changed.length == 0);
  expect(done.refused.length == 0);
  let row = getArtifact(database, "t1", "/notes.md");
  expect(row.id != "");
  expect(row.currentVersion == 1);
  expect(getVersion(database, row.id, 1).body == "alpha\n");
});

test("an emptied run directory deletes nothing at all", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  seeded("/reports/q3.md", "quarter\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md", "/reports/q3.md"], dir);
  fs.rmSync(dir, true);
  fs.mkdirSync(dir, true);
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.missing.length == 2);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
  expect(getArtifact(database, "t1", "/reports/q3.md").currentVersion == 1);
});

// --- reconcile: creation, both ways -----------------------------------------------

test("a new file with mayCreate is created through the same validation as a write", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  fs.mkdirSync(dir + "/out", true);
  fs.writeFileSync(dir + "/out/result.csv", "a,b\n1,2\n");
  let done = scriptReconcile(database, landing(dir, snapshot, true));
  expect(done.ok);
  expect(done.created.length == 1);
  expect(done.created[0].path == "/out/result.csv");
  expect(done.created[0].version == 1);
  let row = getArtifact(database, "t1", "/out/result.csv");
  expect(row.id != "");
  expect(row.kind == "text");
  let body = getVersion(database, row.id, 1);
  expect(body.body == "a,b\n1,2\n");
  expect(body.origin == "generated");
  expect(body.turnSeq == 7);
});

test("a new file without mayCreate is refused and dropped, not saved", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  fs.writeFileSync(dir + "/extra.md", "surprise\n");
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.created.length == 0);
  expect(done.refused.length == 1);
  expect(done.refused[0].path == "/extra.md");
  expect(done.refused[0].problem.indexOf("mayCreate") >= 0);
  expect(getArtifact(database, "t1", "/extra.md").id == "");
});

test("a new file with an unknown extension lands as kind file, carried as base64", () => {
  // The rule this test used to hold — unknown extensions refused — inverted
  // deliberately: a customer's .xml or a script's .tmp is stored as an opaque
  // "file" body rather than turned away, and the body is base64 because that
  // is the one encoding a consumer can rely on without opening it.
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  fs.writeFileSync(dir + "/cache.tmp", "junk");
  let done = scriptReconcile(database, landing(dir, snapshot, true));
  expect(done.ok);
  expect(done.refused.length == 0);
  expect(done.created.length == 1);
  expect(done.created[0].path == "/cache.tmp");
  let made = getArtifact(database, "t1", "/cache.tmp");
  expect(made.kind == "file");
  let body = getVersion(database, made.id, 1).body;
  // "junk" through the system base64, newline-free.
  expect(body == "anVuaw==");
});

test("a new file at the path of an unmaterialised artifact never blindly appends", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  seeded("/other.md", "kept\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  // The script wrote to a path this run never named — there is no snapshot
  // version to precondition against, so landing it would be a blind overwrite.
  fs.writeFileSync(dir + "/other.md", "clobbered\n");
  let done = scriptReconcile(database, landing(dir, snapshot, true));
  expect(done.ok);
  expect(done.created.length == 0);
  expect(done.refused.length == 1);
  expect(done.refused[0].path == "/other.md");
  expect(done.refused[0].problem.indexOf("paths") >= 0);
  let row = getArtifact(database, "t1", "/other.md");
  expect(row.currentVersion == 1);
  expect(getVersion(database, row.id, 1).body == "kept\n");
});

// --- reconcile: the version precondition ------------------------------------------

test("a moved version refuses just that path, naming both versions, and the rest still land", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  seeded("/reports/q3.md", "quarter\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md", "/reports/q3.md"], dir);
  // While the script ran, someone appended version 2 of /notes.md.
  outOfBand("t1:/notes.md", 2, "alpha\nconcurrent\n");
  fs.writeFileSync(dir + "/notes.md", "alpha\nfrom the script\n");
  fs.writeFileSync(dir + "/reports/q3.md", "quarter, revised\n");
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.refused.length == 1);
  expect(done.refused[0].path == "/notes.md");
  expect(done.refused[0].problem.indexOf("1") >= 0);
  expect(done.refused[0].problem.indexOf("2") >= 0);
  // The concurrent writer's body was never replaced, and no version 3 exists.
  expect(getVersion(database, "t1:/notes.md", 2).body == "alpha\nconcurrent\n");
  expect(getVersion(database, "t1:/notes.md", 3).id == "");
  // The sibling still reconciled.
  expect(done.changed.length == 1);
  expect(done.changed[0].path == "/reports/q3.md");
  expect(getVersion(database, "t1:/reports/q3.md", 2).body == "quarter, revised\n");
});

test("a byte-identical file whose version moved mints nothing and refuses nothing", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  outOfBand("t1:/notes.md", 2, "alpha\nconcurrent\n");
  // The script never touched the file, so there is nothing to land and no
  // conflict to report — the concurrent version simply stands.
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.unchanged.length == 1);
  expect(done.refused.length == 0);
  expect(getVersion(database, "t1:/notes.md", 3).id == "");
});

// --- reconcile: the byte caps -----------------------------------------------------

test("a file grown past ARTIFACT_MAX is refused by name while others land", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  seeded("/small.md", "tiny\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md", "/small.md"], dir);
  fs.writeFileSync(dir + "/notes.md", fill("x", ARTIFACT_MAX + 1));
  fs.writeFileSync(dir + "/small.md", "tiny, changed\n");
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.refused.length == 1);
  expect(done.refused[0].path == "/notes.md");
  expect(done.refused[0].problem.indexOf("at most " + `${ARTIFACT_MAX}` + " bytes") >= 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
  expect(done.changed.length == 1);
  expect(done.changed[0].path == "/small.md");
  expect(getArtifact(database, "t1", "/small.md").currentVersion == 2);
});

test("a change past the thread byte budget refuses, naming the cap", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  seeded("/big.md", "tiny\n");
  // The sibling's stored byte count claims the whole budget — the cap reads
  // SUM(bytes), so the claim is enough and the test stays cheap.
  executeWith(database, "UPDATE artifact_versions SET bytes = " + placeholderAt(database, 1)
    + " WHERE artifact_id = " + placeholderAt(database, 2),
    [`${THREAD_BYTES_MAX}`, "t1:/big.md"]);
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  fs.writeFileSync(dir + "/notes.md", "alpha\nbeta\n");
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(done.ok);
  expect(done.refused.length == 1);
  expect(done.refused[0].problem.indexOf("a thread's artifacts hold at most") >= 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
});

// --- reconcile: what a run directory may not smuggle ------------------------------

test("a symbolic link in the run directory is refused, never read", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  fs.rmSync(dir + "/notes.md", false);
  fs.symlinkSync("/etc/hostname", dir + "/notes.md");
  let done = scriptReconcile(database, landing(dir, snapshot, true));
  expect(done.ok);
  expect(done.refused.length == 1);
  expect(done.refused[0].path == "/notes.md");
  expect(done.refused[0].problem.indexOf("link") >= 0);
  // Not missing, not changed: refused is the whole story, and the artifact
  // still holds its own bytes, not the link target's.
  expect(done.missing.length == 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
  expect(getVersion(database, "t1:/notes.md", 1).body == "alpha\n");
});

test("a run directory that is gone reconciles nothing rather than reporting everything deleted", () => {
  fresh();
  seeded("/notes.md", "alpha\n");
  let dir = runDir();
  let snapshot = scriptMaterialise(database, "t1", ["/notes.md"], dir);
  fs.rmSync(dir, true);
  let done = scriptReconcile(database, landing(dir, snapshot, false));
  expect(!done.ok);
  expect(done.problem != "");
  expect(done.missing.length == 0);
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
});

// --- the whole run, docker played by an emulator ----------------------------------
//
// The fake below is more than an argv recorder: it keeps a directory per fake
// container filesystem, so `docker cp` really copies and `docker exec ...
// timeout <s> sh <script>` really runs the script — on the host, in the mapped
// directory. What the tests see is therefore the real materialise -> run ->
// reconcile round trip, with only the daemon replaced.

const FAKE_DIR = "/tmp/agents_script_fake";
const FAKE_LOG = "/tmp/agents_script_fake/argv.log";
const FAKE_CTR = "/tmp/agents_script_fake/ctr";

function fakeDocker(script: string): void {
  if (!fs.existsSync(FAKE_DIR)) { fs.mkdirSync(FAKE_DIR, true); }
  let bin = FAKE_DIR + "/docker";
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 493);
  fs.writeFileSync(FAKE_LOG, "");
  if (fs.existsSync(FAKE_CTR)) { fs.rmSync(FAKE_CTR, true); }
  if (fs.existsSync(FAKE_DIR + "/pruned")) { fs.rmSync(FAKE_DIR + "/pruned", false); }
  envDockerOverride(bin);
}

function dockerEmulated(): void {
  fakeDocker("#!/bin/sh\n"
    + "echo \"$@\" >> " + FAKE_LOG + "\n"
    + "CTR=" + FAKE_CTR + "\n"
    + "case \"$1\" in\n"
    + "info) exit 0 ;;\n"
    + "run) echo c0ffee; exit 0 ;;\n"
    + "start)\n"
    + "  if [ -e " + FAKE_DIR + "/pruned ]; then echo \"No such container\" >&2; exit 1; fi\n"
    + "  exit 0 ;;\n"
    + "stop) exit 0 ;;\n"
    + "rm) exit 0 ;;\n"
    + "cp)\n"
    + "  SRC=\"$2\"; DST=\"$3\"\n"
    + "  case \"$SRC\" in\n"
    + "  *:*) cp -r \"$CTR${SRC#*:}\" \"$DST\" || exit 1 ;;\n"
    + "  *) P=\"$CTR${DST#*:}\"; mkdir -p \"$(dirname \"$P\")\" && cp -r \"$SRC\" \"$P\" || exit 1 ;;\n"
    + "  esac\n"
    + "  exit 0 ;;\n"
    + "exec)\n"
    + "  shift\n"
    + "  WD=/\n"
    + "  while true; do\n"
    + "    case \"$1\" in\n"
    + "    --user) shift 2 ;;\n"
    + "    --workdir) WD=\"$2\"; shift 2 ;;\n"
    + "    -e) shift 2 ;;\n"
    + "    *) break ;;\n"
    + "    esac\n"
    + "  done\n"
    + "  shift\n"
    + "  case \"$1\" in\n"
    + "  chown) exit 0 ;;\n"
    // A real `exec rm -rf` clears the path inside the container, and the
    // staging relies on that: docker cp into an existing directory nests
    // rather than replaces, so a fake that swallows the rm makes the second
    // run of any test read the first run's files.
    + "  rm)\n"
    + "    shift\n"
    + "    [ \"$1\" = \"-rf\" ] && shift\n"
    + "    for P in \"$@\"; do rm -rf \"$CTR$P\"; done\n"
    + "    exit 0 ;;\n"
    + "  timeout)\n"
    + "    cd \"$CTR$WD\" || exit 1\n"
    + "    timeout -k \"$3\" \"$4\" \"$5\" \"$CTR$6\"\n"
    + "    exit $? ;;\n"
    + "  esac\n"
    + "  exit 0 ;;\n"
    + "esac\n"
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

// The first recorded line starting with `prefix`, or "".
function findLine(lines: string[], prefix: string): string {
  let i: int = 0;
  while (i < lines.length) {
    if (lines[i].indexOf(prefix) == 0) { return lines[i]; }
    i = i + 1;
  }
  return "";
}

function running(language: string, source: string, paths: string[], mayCreate: bool, now: string): ScriptRan {
  let asked: ScriptRun = {
    threadId: "t1", language: language, source: source, paths: paths,
    mayCreate: mayCreate, environment: "", agentId: "", turnSeq: 7, now: now,
  };
  return scriptRun(database, asked);
}

test("a script runs in its environment and its changed file lands as the next version", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  let ran = running("sh", "printf 'alpha\\nbeta\\n' > notes.md\necho did-it", ["/notes.md"], false, "1700000000000");
  expect(ran.ok);
  expect(ran.problem == "");
  expect(ran.stopped == "");
  expect(ran.stdout.indexOf("did-it") >= 0);
  expect(ran.changed.length == 1);
  expect(ran.changed[0].path == "/notes.md");
  expect(ran.changed[0].version == 2);
  expect(getVersion(database, "t1:/notes.md", 2).body == "alpha\nbeta\n");
  // The first run is what created the environment, named main.
  let rows = envList(database, "t1");
  expect(rows.length == 1);
  expect(rows[0].name == "main");
  // Created WITH the network — installs are the point of a persistent
  // container — and the script ran as a non-root user, under a wall clock,
  // with the per-run directory as its working directory and a home that
  // persists between runs.
  let asked = argvLines();
  expect(asked[0].indexOf("run -d --name agents-env-t1-main ") == 0);
  expect(asked[0].indexOf("--pids-limit 256") > 0);
  expect(asked[0].indexOf("--network none") < 0);
  let exline = findLine(asked, "exec --user 0:0");
  expect(exline != "");
  // The known path, not a per-run name: a model is told this one once.
  expect(exline.indexOf("--workdir /artifacts") >= 0);
  expect(exline.indexOf("-e HOME=/workspace") >= 0);
  expect(exline.indexOf("timeout -k 5 60 sh /tmp/lumen-job-") >= 0);
  // The run released its slot.
  expect(scriptRunningCount() == 0);
});

test("the environment persists between runs: state outside the run directory survives", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  let first = running("sh", "echo kept > ../kept.txt", ["/notes.md"], false, "1700000000000");
  expect(first.ok);
  clearLog();
  let second = running("sh", "cat ../kept.txt", ["/notes.md"], false, "1700000001000");
  expect(second.ok);
  expect(second.stdout.indexOf("kept") >= 0);
  // The container was reused, not recreated: no docker run line this time.
  expect(findLine(argvLines(), "run -d") == "");
  expect(envList(database, "t1").length == 1);
});

test("a failing script reports stdout, stderr and exit status, and nothing is written", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  let ran = running("sh", "printf 'clobbered' > notes.md\necho out\necho err >&2\nexit 3",
    ["/notes.md"], false, "1700000000000");
  expect(!ran.ok);
  expect(ran.stdout.indexOf("out") >= 0);
  expect(ran.stderr.indexOf("err") >= 0);
  expect(ran.stopped.indexOf("exit status 3") >= 0);
  // The file changed in the container, but a failed run reconciles nothing.
  expect(ran.changed.length == 0);
  expect(getVersion(database, "t1:/notes.md", 2).id == "");
  expect(getArtifact(database, "t1", "/notes.md").currentVersion == 1);
  expect(scriptRunningCount() == 0);
});

test("an unknown language is refused naming what is available, before any container exists", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  let ran = running("ruby", "puts 1", ["/notes.md"], false, "1700000000000");
  expect(!ran.ok);
  expect(ran.problem.indexOf("python") >= 0);
  expect(ran.problem.indexOf("node") >= 0);
  expect(ran.problem.indexOf("sh") >= 0);
  expect(argvLines().length == 0);
  expect(envList(database, "t1").length == 0);
});

test("empty paths are an install-only run, not a refusal", () => {
  // It used to refuse — and a real model burned two of its eight steps
  // retrying pip install with paths it did not have. Nothing is materialised
  // and the reconcile walks an empty directory.
  fresh();
  dockerEmulated();
  let none: string[] = [];
  let ran = running("sh", "true", none, false, "1700000000000");
  expect(ran.ok);
  expect(ran.changed.length == 0);
  expect(ran.created.length == 0);
  expect(envList(database, "t1").length == 1);
});

test("a path that is not an artifact refuses the whole call and mints no container", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  let ran = running("sh", "true", ["/notes.md", "/ghost.md"], false, "1700000000000");
  expect(!ran.ok);
  expect(ran.problem.indexOf("/ghost.md") >= 0);
  expect(argvLines().length == 0);
  expect(envList(database, "t1").length == 0);
  expect(scriptRunningCount() == 0);
});

test("the wall clock kills a script that runs long, and nothing is written", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  scriptWallOverride(1);
  let ran = running("sh", "printf 'late' > notes.md\nsleep 3", ["/notes.md"], false, "1700000000000");
  scriptWallOverride(0);
  expect(!ran.ok);
  expect(ran.stopped.indexOf("wall-clock") >= 0);
  expect(getVersion(database, "t1:/notes.md", 2).id == "");
  expect(scriptRunningCount() == 0);
});

test("output past the cap keeps a prefix and writes nothing", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  scriptOutputOverride(32);
  let ran = running("sh", "printf 'grew' > notes.md\nseq 1 100", ["/notes.md"], false, "1700000000000");
  scriptOutputOverride(0);
  expect(!ran.ok);
  expect(ran.stopped.indexOf("bytes of UTF-8") >= 0);
  expect(ran.stdout.length <= 32);
  expect(ran.stdout.length > 0);
  expect(getVersion(database, "t1:/notes.md", 2).id == "");
});

test("a created file arrives as a new artifact when mayCreate allows it", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  let ran = running("sh", "printf 'a,b\\n' > result.csv", ["/notes.md"], true, "1700000000000");
  expect(ran.ok);
  expect(ran.created.length == 1);
  expect(ran.created[0].path == "/result.csv");
  expect(ran.created[0].version == 1);
  expect(ran.unchanged.length == 1);
  expect(getVersion(database, "t1:/result.csv", 1).body == "a,b\n");
});

test("one script at a time per environment: a second is refused, naming the run in flight", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  let container = envContainerName("t1", "main");
  expect(scriptAcquire(container, "main", "1700000000000") == "");
  clearLog();
  let ran = running("sh", "true", ["/notes.md"], false, "1700000000500");
  expect(!ran.ok);
  expect(ran.problem.indexOf("already running a script") >= 0);
  expect(ran.problem.indexOf("main") >= 0);
  // Refused, not queued: docker was never asked for anything.
  expect(argvLines().length == 0);
  scriptRelease(container);
  // With the run in flight gone, the same call goes through.
  let again = running("sh", "true", ["/notes.md"], false, "1700000001000");
  expect(again.ok);
  expect(scriptRunningCount() == 0);
});

test("the deployment ceiling refuses another script, naming the count", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  expect(scriptAcquire("agents-env-a-main", "main", "1") == "");
  expect(scriptAcquire("agents-env-b-main", "main", "2") == "");
  let ran = running("sh", "true", ["/notes.md"], false, "1700000000000");
  expect(!ran.ok);
  expect(ran.problem.indexOf("2 scripts") >= 0);
  expect(ran.problem.indexOf("refused rather than queued") >= 0);
  expect(argvLines().length == 0);
  scriptRelease("agents-env-a-main");
  scriptRelease("agents-env-b-main");
  expect(scriptRunningCount() == 0);
});

test("a pruned container is recreated and the run says the cache was lost", () => {
  fresh();
  dockerEmulated();
  seeded("/notes.md", "alpha\n");
  let first = running("sh", "true", ["/notes.md"], false, "1700000000000");
  expect(first.ok);
  expect(!first.recreated);
  let s: EnvSweep = { now: "1700000900001", idleMs: ENV_IDLE_MS };
  expect(envIdle(database, s) == 1);
  // The daemon lost the container while the environment slept.
  fs.writeFileSync(FAKE_DIR + "/pruned", "");
  let back = running("sh", "true", ["/notes.md"], false, "1700001000000");
  expect(back.ok);
  expect(back.recreated);
});

test("the docker probe is asked once per process and remembered", () => {
  dockerEmulated();
  scriptProbeReset();
  expect(scriptDockerWorks());
  // Break the fake: the memo still answers yes until it is reset.
  fakeDocker("#!/bin/sh\nexit 1\n");
  expect(scriptDockerWorks());
  scriptProbeReset();
  expect(!scriptDockerWorks());
  scriptProbeReset();
});

test("an environment name is refused before anything exists: bytes counted as bytes, charset closed", () => {
  fresh();
  dockerEmulated();
  seeded("/a.md", "hello\n");
  // 60 two-byte letters is 120 bytes — over the 40-byte cap, and the refusal
  // must name the unit, or a model that counted 60 characters reads
  // arithmetic it cannot reproduce.
  let wide = "";
  let i: int = 0;
  while (i < 60) { wide = wide + "ل"; i = i + 1; }
  let long = scriptRun(database, {
    threadId: "t1", language: "sh", source: "true", paths: ["/a.md"],
    mayCreate: false, environment: wide, agentId: "", turnSeq: -1, now: "1785200000000",
  });
  expect(!long.ok);
  expect(long.problem.includes("bytes of UTF-8"));
  expect(long.problem.includes("120"));

  // A name inside the cap but outside the charset is refused too — sanitised,
  // two such names would share a container.
  let odd = scriptRun(database, {
    threadId: "t1", language: "sh", source: "true", paths: ["/a.md"],
    mayCreate: false, environment: "prod env", agentId: "", turnSeq: -1, now: "1785200000000",
  });
  expect(!odd.ok);
  expect(odd.problem.includes("letters, digits, dot, dash and underscore"));

  // Neither refusal minted a row or touched docker.
  expect(envList(database, "t1").length == 0);
  expect(argvLines().length == 0);
});

test("a source that is the run_script(...) call itself is refused before the shell sees it", () => {
  fresh();
  dockerEmulated();
  // What a weak model emits: the whole call re-wrapped into `source`. Run as-is
  // the shell reports "word unexpected" on the `(`; caught here it names the fix.
  let ran = running("sh",
    "run_script(environment=\"search\", language=\"sh\", source='python /skills/x.py \"q\"')",
    [], false, "1785200000000");
  expect(!ran.ok);
  expect(ran.problem.includes("run_script(...) call itself"));
  // Nothing ran: no row minted, docker untouched.
  expect(envList(database, "t1").length == 0);
  expect(argvLines().length == 0);
});

test("an install-only run has no paths, and mayCreate still gates what it leaves behind", () => {
  fresh();
  dockerEmulated();
  let ran = running("sh", "echo installed-something\ntouch stray.txt", [], false, "1785200000000");
  expect(ran.ok);
  expect(ran.stdout.indexOf("installed-something") >= 0);
  // The stray file was reported and dropped, not saved: mayCreate was false.
  expect(ran.created.length == 0);
  expect(ran.refused.length == 1);
  expect(ran.refused[0].path == "/stray.txt");
});

test("a binary image round-trips as base64: decoded for the script, re-encoded for the store", () => {
  // A PNG is not UTF-8, so the store holds base64 and the run directory holds
  // bytes. The script writes real binary; the reconcile brings it back
  // encoded; a later run materialises it decoded, byte for byte.
  fresh();
  dockerEmulated();
  // Two real PNG bytes prove nothing — use a header that is invalid UTF-8.
  let made = running("sh",
    "printf '\\211PNG\\r\\n\\032\\n' > logo.png\necho wrote-image", [], true, "1785200000000");
  expect(made.ok);
  expect(made.created.length == 1);
  expect(made.created[0].path == "/logo.png");
  // Stored as base64 of exactly those eight bytes.
  let stored = getVersion(database, "t1:/logo.png", 1);
  expect(stored.body == "iVBORw0KGgo=");

  // The next run reads the same eight bytes back.
  let read = running("sh",
    "cksum logo.png | cut -d' ' -f2", ["/logo.png"], false, "1785200001000");
  expect(read.ok);
  expect(read.stdout.trim() == "8");
  expect(read.unchanged.length == 1);
});

test("an agent's curated image is what its containers are built from, with a working fallback", () => {
  // The choice is configuration's, never the call's: nothing a model sends
  // names an image, and scriptRun asks the agent's row.
  fresh();
  dockerEmulated();
  execute(database, "CREATE TABLE IF NOT EXISTS script_images (id text PRIMARY KEY, label text NOT NULL, image text NOT NULL, enabled integer NOT NULL)");
  execute(database, "CREATE TABLE IF NOT EXISTS agents (id text PRIMARY KEY, agent_name text NOT NULL, description text NOT NULL, model_config_id text NOT NULL, prompt_id text NOT NULL, enabled integer NOT NULL, is_default integer NOT NULL, script_image_id text NOT NULL DEFAULT '', updated_at text NOT NULL)");
  // A named agent's run also asks after its skills, so the tables must answer.
  execute(database, "CREATE TABLE IF NOT EXISTS skills (id text PRIMARY KEY, skill_name text NOT NULL, description text NOT NULL, body text NOT NULL, updated_at text NOT NULL)");
  execute(database, "CREATE TABLE IF NOT EXISTS skill_files (id text PRIMARY KEY, skill_id text NOT NULL, path text NOT NULL, body text NOT NULL)");
  execute(database, "CREATE TABLE IF NOT EXISTS agent_skills (agent_id text NOT NULL, skill_id text NOT NULL)");
  execute(database, "INSERT INTO script_images VALUES ('img-node', 'Node toolchain', 'node:22-bookworm', 1)");
  execute(database, "INSERT INTO script_images VALUES ('img-off', 'Retired', 'old:1', 0)");
  execute(database, "INSERT INTO agents VALUES ('a-node', 'node agent', '', 'c1', 'p1', 1, 0, 'img-node', 'now')");
  execute(database, "INSERT INTO agents VALUES ('a-gone', 'stale agent', '', 'c1', 'p1', 1, 0, 'img-vanished', 'now')");
  execute(database, "INSERT INTO agents VALUES ('a-off', 'retired image', '', 'c1', 'p1', 1, 0, 'img-off', 'now')");
  execute(database, "INSERT INTO agents VALUES ('a-plain', 'no choice', '', 'c1', 'p1', 1, 0, '', 'now')");

  expect(scriptImageFor(database, "a-node") == "node:22-bookworm");
  // Every way of not having a usable choice falls back to the deployment
  // default rather than refusing: an operator retiring an image must not
  // break the conversations that pointed at it.
  expect(scriptImageFor(database, "a-plain") == scriptImage());
  expect(scriptImageFor(database, "a-gone") == scriptImage());
  expect(scriptImageFor(database, "a-off") == scriptImage());
  expect(scriptImageFor(database, "") == scriptImage());

  // And the run builds the container from it.
  seeded("/notes.md", "alpha\n");
  let ran = scriptRun(database, {
    threadId: "t1", language: "sh", source: "true", paths: ["/notes.md"],
    mayCreate: false, environment: "", agentId: "a-node", turnSeq: 3, now: "1785200000000",
  });
  expect(ran.ok);
  expect(argvLines()[0].indexOf("--entrypoint sleep node:22-bookworm infinity") > 0);
});

test("a skill's files are staged at /skills, and an edit is what the next run executes", () => {
  fresh();
  dockerEmulated();
  // Dropped before created: the database file outlives a suite execution, and
  // an INSERT that collides with last time's rows loses silently — the first
  // symptom was this test reading the previous execution's UPDATE.
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP TABLE IF EXISTS agents");
  execute(database, "CREATE TABLE agents (id text PRIMARY KEY, agent_name text NOT NULL, description text NOT NULL, model_config_id text NOT NULL, prompt_id text NOT NULL, enabled integer NOT NULL, is_default integer NOT NULL, script_image_id text NOT NULL DEFAULT '', updated_at text NOT NULL)");
  // visibility and featured_rank are migrations 77/78, and this hand-rolled
  // table has to carry them: staging reads the skills through skillsMapping(),
  // whose SELECT names every column, and agentSkills' WHERE mentions
  // visibility by name — a table missing them fails the read rather than
  // returning a skill without them.
  execute(database, "CREATE TABLE skills (id text PRIMARY KEY, skill_name text NOT NULL, description text NOT NULL, body text NOT NULL, updated_at text NOT NULL, visibility text NOT NULL DEFAULT 'private', featured_rank integer NOT NULL DEFAULT 0)");
  execute(database, "CREATE TABLE skill_files (id text PRIMARY KEY, skill_id text NOT NULL, path text NOT NULL, body text NOT NULL)");
  execute(database, "CREATE TABLE agent_skills (agent_id text NOT NULL, skill_id text NOT NULL)");
  execute(database, "INSERT INTO agents VALUES ('a1', 'skilled', '', 'c1', 'p1', 1, 0, '', 'now')");
  // Private, and reached by the agent_skills row below: staging an attached
  // skill is the case under test, and 'public' would have staged it for an
  // agent that never linked it.
  execute(database, "INSERT INTO skills VALUES ('k1', 'read-proto-enums', 'compute enum values', 'Run the script.', 'now', 'private', 0)");
  execute(database, "INSERT INTO skill_files VALUES ('f1', 'k1', 'enums.py', 'print(1)')");
  execute(database, "INSERT INTO agent_skills VALUES ('a1', 'k1')");

  seeded("/notes.md", "alpha\n");
  let ran = scriptRun(database, {
    threadId: "t1", language: "sh", source: "true", paths: ["/notes.md"],
    mayCreate: false, environment: "", agentId: "a1", turnSeq: 3, now: "1785200000000",
  });
  expect(ran.ok);
  // The container's /skills was cleared and re-placed, at the path the
  // skill's body promises.
  expect(findLine(argvLines(), "exec agents-env-t1-main rm -rf /skills") != "");
  let placed = fs.readFileSync(FAKE_CTR + "/skills/read-proto-enums/enums.py");
  expect(placed == "print(1)");

  // The edit, live on the very next run — the artifact staleness rule.
  execute(database, "UPDATE skill_files SET body = 'print(2)' WHERE id = 'f1'");
  let again = scriptRun(database, {
    threadId: "t1", language: "sh", source: "true", paths: ["/notes.md"],
    mayCreate: false, environment: "", agentId: "a1", turnSeq: 4, now: "1785200005000",
  });
  expect(again.ok);
  expect(fs.readFileSync(FAKE_CTR + "/skills/read-proto-enums/enums.py") == "print(2)");
});
