import { Db } from "../plume/driver.ts";
import { executeWith, findById, listWhere, placeholderAt, beginTransaction, commitTransaction, rollbackTransaction } from "../plume/plume.ts";
import { ARTIFACT_MAX, ARTIFACT_NOTE_MAX, THREAD_BYTES_MAX, binaryKind, getArtifact, getVersion, kindOf, labelFault, nextVersion, putArtifact, threadBytes, utf8Length } from "./artifacts.ts";
import { EnvDockerReply, EnvEnsure, envContainerName, envDockerBin, envEnsure, envList } from "./environments.ts";
import { masterKey } from "./credentials.ts";
import { envKeyFileBody, touchEnvKeys } from "./env-keys.ts";
import { userEnvByName } from "./user-environments.ts";
import { normalScope } from "./knowledge.ts";
import { AgentRow, ScriptImageRow, SkillRow, SkillFileRow, agentsMapping, scriptImagesMapping, skillsMapping, skillFilesMapping } from "./schema.ts";

export type ScriptFile = {
  path: string,
  version: int,
  ok: bool,
  fault: string,
};

export type ScriptReconcile = {
  threadId: string,
  dir: string,
  snapshot: ScriptFile[],
  mayCreate: bool,
  note: string,
  turnSeq: int,
  now: string,
};

export type ScriptVersioned = {
  path: string,
  version: int,
};

export type ScriptRefusal = {
  path: string,
  fault: string,
};

export type ScriptReconciled = {
  ok: bool,
  changed: ScriptVersioned[],
  created: ScriptVersioned[],
  unchanged: ScriptVersioned[],
  missing: string[],
  refused: ScriptRefusal[],
  fault: string,
};

export function scriptMaterialise(db: Db, threadId: string, paths: string[], dir: string): ScriptFile[] {
  let out: ScriptFile[] = [];
  let i: int = 0;
  while (i < paths.length) {
    out.push(materialiseOne(db, threadId, paths[i], dir));
    i = i + 1;
  }
  return out;
}

function fileRefusal(path: string, why: string): ScriptFile {
  let out: ScriptFile = { path: path, version: 0, ok: false, fault: why };
  return out;
}

function materialiseOne(db: Db, threadId: string, raw: string, dir: string): ScriptFile {
  let path = normalScope(raw);
  if (threadId == "") {
    return fileRefusal(path, "an artifact belongs to a thread");
  }
  let artifact = getArtifact(db, threadId, path);
  if (artifact.id == "") {
    return fileRefusal(path, "There is no artifact at " + path + " in this conversation.");
  }
  let current = getVersion(db, artifact.id, artifact.currentVersion);
  if (current.id == "") {
    return fileRefusal(path, "Artifact " + path + " points at version "
      + `${artifact.currentVersion}` + ", which is not in its history.");
  }
  let placed = placeFile(dir, path, current.body);
  if (placed != "") {
    return fileRefusal(path, placed);
  }
  let out: ScriptFile = { path: path, version: artifact.currentVersion, ok: true, fault: "" };
  return out;
}

function placeFile(dir: string, path: string, body: string): string {
  let cut = path.lastIndexOf("/");
  let parent = dir + path.slice(0, cut);
  try {
    fs.mkdirSync(parent, true);
    if (binaryKind(kindOf(path))) {
      fs.writeFileSync(dir + path + ".b64", body);
      let dec = child_process.spawnSync("sh", ["-c",
        "base64 -d < '" + dir + path + ".b64' > '" + dir + path + "' && rm '" + dir + path + ".b64'"]);
      if (dec.status != 0) {
        return "could not decode " + path + " into the run directory";
      }
    } else {
      fs.writeFileSync(dir + path, body);
    }
  } catch (e) {
    return "could not write " + path + " into the run directory";
  }
  return "";
}

type ScriptWalk = {
  files: string[],
  links: string[],
  fault: string,
};

function walkFailed(): ScriptWalk {
  let files: string[] = [];
  let links: string[] = [];
  let out: ScriptWalk = {
    files: files, links: links,
    fault: "the run directory could not be read; nothing was reconciled",
  };
  return out;
}

function walkRun(base: string, rel: string): ScriptWalk {
  let files: string[] = [];
  let links: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(base + rel);
  } catch (e) {
    return walkFailed();
  }
  names = names.sort();
  let i: int = 0;
  while (i < names.length) {
    let path = rel + "/" + names[i];
    let entry = classifyEntry(base, path);
    if (entry == "file") {
      files.push(path);
    } else if (entry == "link") {
      links.push(path);
    } else if (entry == "dir") {
      let sub = walkRun(base, path);
      if (sub.fault != "") {
        return sub;
      }
      let f: int = 0;
      while (f < sub.files.length) {
        files.push(sub.files[f]);
        f = f + 1;
      }
      let l: int = 0;
      while (l < sub.links.length) {
        links.push(sub.links[l]);
        l = l + 1;
      }
    } else if (entry == "gone") {
      return walkFailed();
    }
    i = i + 1;
  }
  let out: ScriptWalk = { files: files, links: links, fault: "" };
  return out;
}

function classifyEntry(base: string, path: string): string {
  try {
    if (fs.readlinkSync(base + path) != "") {
      return "link";
    }
    let st = fs.statSync(base + path);
    if (st.isDirectory) {
      return "dir";
    }
    if (st.isFile) {
      return "file";
    }
  } catch (e) {
    return "gone";
  }
  return "";
}

type ScriptOutcome = {
  kind: string,
  path: string,
  version: int,
  fault: string,
};

function outcomeLanded(kind: string, path: string, version: int): ScriptOutcome {
  let out: ScriptOutcome = { kind: kind, path: path, version: version, fault: "" };
  return out;
}

function outcomeRefused(path: string, why: string): ScriptOutcome {
  let out: ScriptOutcome = { kind: "refused", path: path, version: 0, fault: why };
  return out;
}

function reconcileFault(why: string): ScriptReconciled {
  let changed: ScriptVersioned[] = [];
  let created: ScriptVersioned[] = [];
  let unchanged: ScriptVersioned[] = [];
  let missing: string[] = [];
  let refused: ScriptRefusal[] = [];
  let out: ScriptReconciled = {
    ok: false, changed: changed, created: created, unchanged: unchanged,
    missing: missing, refused: refused, fault: why,
  };
  return out;
}

export function scriptReconcile(db: Db, run: ScriptReconcile): ScriptReconciled {
  if (run.threadId == "") {
    return reconcileFault("an artifact belongs to a thread");
  }
  let badNote = labelFault("note", run.note, ARTIFACT_NOTE_MAX);
  if (badNote != "") {
    return reconcileFault(badNote);
  }
  if (!fs.existsSync(run.dir)) {
    return reconcileFault("the run directory is gone; nothing was reconciled");
  }

  let walked = walkRun(run.dir, "");
  if (walked.fault != "") {
    return reconcileFault(walked.fault);
  }
  let files = walked.files;
  let links = walked.links;

  let changed: ScriptVersioned[] = [];
  let created: ScriptVersioned[] = [];
  let unchanged: ScriptVersioned[] = [];
  let missing: string[] = [];
  let refused: ScriptRefusal[] = [];

  let i: int = 0;
  while (i < files.length) {
    let path = files[i];
    let at = snapshotAt(run.snapshot, path);
    let outcome = at >= 0
      ? reconcileKnown(db, run, run.snapshot[at])
      : reconcileNew(db, run, path);
    if (outcome.kind == "changed") {
      let landed: ScriptVersioned = { path: outcome.path, version: outcome.version };
      changed.push(landed);
    } else if (outcome.kind == "created") {
      let minted: ScriptVersioned = { path: outcome.path, version: outcome.version };
      created.push(minted);
    } else if (outcome.kind == "unchanged") {
      let same: ScriptVersioned = { path: outcome.path, version: outcome.version };
      unchanged.push(same);
    } else {
      let no: ScriptRefusal = { path: outcome.path, fault: outcome.fault };
      refused.push(no);
    }
    i = i + 1;
  }

  let ln: int = 0;
  while (ln < links.length) {
    let linked: ScriptRefusal = {
      path: links[ln],
      fault: links[ln] + " is a symbolic link, and a run may only save regular files",
    };
    refused.push(linked);
    ln = ln + 1;
  }

  let m: int = 0;
  while (m < run.snapshot.length) {
    let snap = run.snapshot[m];
    if (snap.ok && !listedIn(files, snap.path) && !listedIn(links, snap.path)
      && !listedIn(missing, snap.path)) {
      missing.push(snap.path);
    }
    m = m + 1;
  }

  let out: ScriptReconciled = {
    ok: true, changed: changed, created: created, unchanged: unchanged,
    missing: missing, refused: refused, fault: "",
  };
  return out;
}

function snapshotAt(snapshot: ScriptFile[], path: string): int {
  let i: int = 0;
  while (i < snapshot.length) {
    if (snapshot[i].ok && snapshot[i].path == path) {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

function listedIn(list: string[], path: string): bool {
  let i: int = 0;
  while (i < list.length) {
    if (list[i] == path) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

type ScriptRead = {
  ok: bool,
  body: string,
};

function sizeOf(path: string): int {
  try {
    let st = fs.statSync(path);
    return st.size;
  } catch (e) {
    return -1;
  }
}

function readBack(artifactPath: string, path: string): ScriptRead {
  if (binaryKind(kindOf(artifactPath))) {
    let enc = child_process.spawnSync("base64", ["-w0", path]);
    if (enc.status != 0) {
      let bad: ScriptRead = { ok: false, body: "" };
      return bad;
    }
    let out: ScriptRead = { ok: true, body: enc.stdout.trim() };
    return out;
  }
  try {
    let body = fs.readFileSync(path);
    let out: ScriptRead = { ok: true, body: body };
    return out;
  } catch (e) {
    let bad: ScriptRead = { ok: false, body: "" };
    return bad;
  }
}

type ScriptAppend = {
  threadId: string,
  path: string,
  body: string,
  baseVersion: int,
  note: string,
  turnSeq: int,
  now: string,
};

type ScriptAppended = {
  ok: bool,
  version: int,
  fault: string,
};

function appendRefusal(why: string): ScriptAppended {
  let out: ScriptAppended = { ok: false, version: 0, fault: why };
  return out;
}

function movedRefusal(path: string, base: int, newest: int): ScriptAppended {
  return appendRefusal("the newest version of " + path + " moved from " + `${base}`
    + " to " + `${newest}` + " while the script ran; its change was not saved — "
    + "read the current version and apply the change again");
}

function scriptAppend(db: Db, append: ScriptAppend): ScriptAppended {
  let bytes = utf8Length(append.body);
  if (bytes > ARTIFACT_MAX) {
    return appendRefusal("an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${bytes}`);
  }

  let opened = beginTransaction(db);
  if (!opened.ok) {
    return appendRefusal("the change to " + append.path + " could not be saved; try again");
  }

  let artifact = getArtifact(db, append.threadId, append.path);
  if (artifact.id == "") {
    rollbackTransaction(db);
    return appendRefusal("There is no artifact at " + append.path + " in this conversation.");
  }

  let past = nextVersion(db, artifact.id);
  if (past < 2) {
    rollbackTransaction(db);
    return appendRefusal("the version history of " + append.path + " could not be read");
  }
  let newest = past - 1;
  if (newest != append.baseVersion) {
    rollbackTransaction(db);
    return movedRefusal(append.path, append.baseVersion, newest);
  }

  let held = threadBytes(db, append.threadId);
  if (held < 0) {
    rollbackTransaction(db);
    return appendRefusal("could not read how much this thread's artifacts hold");
  }
  if (held + bytes > THREAD_BYTES_MAX) {
    rollbackTransaction(db);
    return appendRefusal("a thread's artifacts hold at most " + `${THREAD_BYTES_MAX}` + " bytes across all versions; this write would exceed that");
  }

  let version = append.baseVersion + 1;
  let wrote = executeWith(db,
    "INSERT INTO artifact_versions (id, artifact_id, version, body, bytes, origin, turn_seq, note, created_at) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", " + placeholderAt(db, 3) + ", "
    + placeholderAt(db, 4) + ", " + placeholderAt(db, 5) + ", " + placeholderAt(db, 6) + ", "
    + placeholderAt(db, 7) + ", " + placeholderAt(db, 8) + ", " + placeholderAt(db, 9) + ")",
    [artifact.id + ":" + `${version}`, artifact.id, `${version}`, append.body, `${bytes}`,
     "generated", `${append.turnSeq}`, append.note, append.now]);
  if (!wrote.ok) {
    rollbackTransaction(db);
    let raced = nextVersion(db, artifact.id);
    let standing = raced < 2 ? append.baseVersion + 1 : raced - 1;
    return movedRefusal(append.path, append.baseVersion, standing);
  }

  let moved = executeWith(db,
    "UPDATE artifacts SET current_version = " + placeholderAt(db, 1)
    + ", updated_at = " + placeholderAt(db, 2)
    + " WHERE id = " + placeholderAt(db, 3),
    [`${version}`, append.now, artifact.id]);
  if (!moved.ok) {
    rollbackTransaction(db);
    return appendRefusal("the change to " + append.path + " could not be saved; try again");
  }

  let done = commitTransaction(db);
  if (!done.ok) {
    rollbackTransaction(db);
    return appendRefusal("the change to " + append.path + " could not be saved; try again");
  }
  let out: ScriptAppended = { ok: true, version: version, fault: "" };
  return out;
}

function reconcileKnown(db: Db, run: ScriptReconcile, snap: ScriptFile): ScriptOutcome {
  let size = sizeOf(run.dir + snap.path);
  if (size > ARTIFACT_MAX) {
    return outcomeRefused(snap.path,
      "an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${size}`);
  }
  let read = readBack(snap.path, run.dir + snap.path);
  if (!read.ok) {
    return outcomeRefused(snap.path, snap.path + " could not be read back from the run directory");
  }

  let base = getVersion(db, run.threadId + ":" + snap.path, snap.version);
  if (base.id == "") {
    return outcomeRefused(snap.path, "the version history of " + snap.path + " could not be read");
  }
  if (read.body == base.body) {
    return outcomeLanded("unchanged", snap.path, snap.version);
  }

  let landed = scriptAppend(db, {
    threadId: run.threadId, path: snap.path, body: read.body,
    baseVersion: snap.version, note: run.note, turnSeq: run.turnSeq, now: run.now,
  });
  if (!landed.ok) {
    return outcomeRefused(snap.path, landed.fault);
  }
  return outcomeLanded("changed", snap.path, landed.version);
}

function reconcileNew(db: Db, run: ScriptReconcile, path: string): ScriptOutcome {
  let existing = getArtifact(db, run.threadId, path);
  if (existing.id != "") {
    return outcomeRefused(path,
      path + " is already an artifact of this conversation and was not in the run's paths; name it there to update it");
  }
  if (!run.mayCreate) {
    return outcomeRefused(path,
      "the run created " + path + ", but mayCreate was false; it was not saved");
  }
  let size = sizeOf(run.dir + path);
  if (size > ARTIFACT_MAX) {
    return outcomeRefused(path,
      "an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${size}`);
  }
  let read = readBack(path, run.dir + path);
  if (!read.ok) {
    return outcomeRefused(path, path + " could not be read back from the run directory");
  }
  let put = putArtifact(db, {
    threadId: run.threadId, path: path, title: "", content: read.body,
    note: run.note, origin: "generated", mustCreate: true,
    turnSeq: run.turnSeq, now: run.now,
  });
  if (!put.ok) {
    return outcomeRefused(path, put.fault);
  }
  return outcomeLanded("created", path, put.version);
}

export function scriptImage(): string {
  return process.env("AGENTS_SCRIPT_IMAGE") ?? "agents-runtime:1";
}

export function foldName(n: string): string {
  return n.toLowerCase().replaceAll("-", "").replaceAll("_", "").replaceAll(" ", "").replaceAll("+", "");
}

export function scriptImageForEnv(db: Db, agentId: string, envName: string): string {
  if (envName == "" || envName == "main") {
    return scriptImageFor(db, agentId);
  }
  let rows = JSON.parse<ScriptImageRow[]>(listWhere(db, scriptImagesMapping(), "enabled = " + placeholderAt(db, 1), ["1"]));
  let i: int = 0;
  while (i < rows.length) {
    if (foldName(rows[i].label) == foldName(envName) && rows[i].image != "") {
      return rows[i].image;
    }
    i = i + 1;
  }
  return "";
}

export const DEFAULT_IMAGE_ID: string = "default";

export function scriptImageIdFor(db: Db, agentId: string): string {
  if (agentId == "") {
    return DEFAULT_IMAGE_ID;
  }
  let held = findById(db, agentsMapping(), agentId);
  if (held == "") {
    return DEFAULT_IMAGE_ID;
  }
  let chosen = JSON.parse<AgentRow>(held).scriptImageId;
  if (chosen == "") {
    return DEFAULT_IMAGE_ID;
  }
  let row = findById(db, scriptImagesMapping(), chosen);
  if (row == "") {
    return DEFAULT_IMAGE_ID;
  }
  let image: ScriptImageRow = JSON.parse<ScriptImageRow>(row);
  if (!image.enabled || image.image == "") {
    return DEFAULT_IMAGE_ID;
  }
  return image.id;
}

export function scriptImageIdForEnv(db: Db, agentId: string, envName: string): string {
  if (envName == "" || envName == "main") {
    return scriptImageIdFor(db, agentId);
  }
  let rows = JSON.parse<ScriptImageRow[]>(listWhere(db, scriptImagesMapping(), "enabled = " + placeholderAt(db, 1), ["1"]));
  let i: int = 0;
  while (i < rows.length) {
    if (foldName(rows[i].label) == foldName(envName) && rows[i].image != "") {
      return rows[i].id;
    }
    i = i + 1;
  }
  return "";
}

export function scriptImageFor(db: Db, agentId: string): string {
  if (agentId == "") {
    return scriptImage();
  }
  let held = findById(db, agentsMapping(), agentId);
  if (held == "") {
    return scriptImage();
  }
  let chosen = JSON.parse<AgentRow>(held).scriptImageId;
  if (chosen == "") {
    return scriptImage();
  }
  let row = findById(db, scriptImagesMapping(), chosen);
  if (row == "") {
    return scriptImage();
  }
  let image: ScriptImageRow = JSON.parse<ScriptImageRow>(row);
  if (!image.enabled || image.image == "") {
    return scriptImage();
  }
  return image.image;
}

export const SCRIPT_MAX_RUNNING: int = 2;

export const SCRIPT_WALL_SECONDS: int = 60;
export const SCRIPT_OUTPUT_MAX: int = 65536;

const SCRIPT_UID: string = "0:0";

const SCRIPT_KILL_GRACE: string = "5";

export const SCRIPT_RUN_DIR: string = "/artifacts";

const SCRIPT_NOTE: string = "run_script";

let scriptWallChosen: int = 0;
export function scriptWallOverride(seconds: int): void {
  scriptWallChosen = seconds;
}
function scriptWallSeconds(): int {
  return scriptWallChosen > 0 ? scriptWallChosen : SCRIPT_WALL_SECONDS;
}

let scriptOutputChosen: int = 0;
export function scriptOutputOverride(bytes: int): void {
  scriptOutputChosen = bytes;
}
function scriptOutputMax(): int {
  return scriptOutputChosen > 0 ? scriptOutputChosen : SCRIPT_OUTPUT_MAX;
}

let scriptProbed: int = -1;

export function scriptProbeReset(): void {
  scriptProbed = -1;
}

export function scriptDockerWorks(): bool {
  if (scriptProbed < 0) {
    let asked = scriptDocker(["info"]);
    scriptProbed = asked.status == 0 ? 1 : 0;
  }
  return scriptProbed == 1;
}

function scriptDocker(args: string[]): EnvDockerReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let reply: EnvDockerReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return reply;
}

function scriptDockerFailed(doing: string, reply: EnvDockerReply): string {
  let line = scriptFirstLine(reply.stderr);
  if (line == "") {
    line = scriptFirstLine(reply.stdout);
  }
  if (line == "") {
    return "docker could not " + doing + " (docker itself did not run)";
  }
  return "docker could not " + doing + ": " + scriptCut(line, 200);
}

function scriptFirstLine(text: string): string {
  let end: int = 0;
  while (end < text.length && text.charCodeAt(end) != 10 && text.charCodeAt(end) != 13) {
    end = end + 1;
  }
  return text.slice(0, end).trim();
}

function scriptCut(text: string, cap: int): string {
  if (text.length <= cap) {
    return text;
  }
  let cut = cap;
  while (cut > 0) {
    let b = text.charCodeAt(cut);
    if (b < 128 || b >= 192) {
      break;
    }
    cut = cut - 1;
  }
  return text.slice(0, cut);
}

let scriptHeldNow: string = "";

function scriptHeldLines(): string[] {
  let out: string[] = [];
  if (scriptHeldNow == "") {
    return out;
  }
  let parts = scriptHeldNow.split("\n");
  let i: int = 0;
  while (i < parts.length) {
    if (parts[i] != "") {
      out.push(parts[i]);
    }
    i = i + 1;
  }
  return out;
}

export function scriptRunningCount(): int {
  return scriptHeldLines().length;
}

export function scriptAcquire(container: string, envName: string, now: string): string {
  let held = scriptHeldLines();
  if (held.length >= SCRIPT_MAX_RUNNING) {
    return "this deployment is already running " + `${held.length}`
      + " scripts, which is its ceiling; the call was refused rather than queued — try again when one finishes";
  }
  let i: int = 0;
  while (i < held.length) {
    let cut = held[i].indexOf(" ");
    let key = cut < 0 ? held[i] : held[i].slice(0, cut);
    if (key == container) {
      let since = cut < 0 ? "" : held[i].slice(cut + 1, held[i].length);
      return "environment \"" + envName + "\" is already running a script, started at " + since
        + "; one script at a time per environment — wait for it or use another environment";
    }
    i = i + 1;
  }
  scriptHeldNow = scriptHeldNow + container + " " + now + "\n";
  return "";
}

export function scriptRelease(container: string): void {
  let held = scriptHeldLines();
  let out = "";
  let i: int = 0;
  while (i < held.length) {
    let cut = held[i].indexOf(" ");
    let key = cut < 0 ? held[i] : held[i].slice(0, cut);
    if (key != container) {
      out = out + held[i] + "\n";
    }
    i = i + 1;
  }
  scriptHeldNow = out;
}

export type ScriptRun = {
  threadId: string,
  language: string,
  source: string,
  paths: string[],
  mayCreate: bool,
  environment: string,
  agentId: string,
  turnSeq: int,
  now: string,
};

export type ScriptRan = {
  ok: bool,
  stdout: string,
  stderr: string,
  changed: ScriptVersioned[],
  created: ScriptVersioned[],
  unchanged: ScriptVersioned[],
  missing: string[],
  refused: ScriptRefusal[],
  stopped: string,
  recreated: bool,
  fault: string,
};

function scriptRanFlat(ok: bool, stdout: string, stderr: string, stopped: string, recreated: bool, fault: string): ScriptRan {
  let changed: ScriptVersioned[] = [];
  let created: ScriptVersioned[] = [];
  let unchanged: ScriptVersioned[] = [];
  let missing: string[] = [];
  let refused: ScriptRefusal[] = [];
  let out: ScriptRan = {
    ok: ok, stdout: stdout, stderr: stderr, changed: changed, created: created,
    unchanged: unchanged, missing: missing, refused: refused,
    stopped: stopped, recreated: recreated, fault: fault,
  };
  return out;
}

function scriptRefused(why: string): ScriptRan {
  return scriptRanFlat(false, "", "", "", false, why);
}

function scriptBail(container: string, stage: string, why: string): ScriptRan {
  scriptHostDrop(stage);
  scriptRelease(container);
  return scriptRefused(why);
}

function scriptDone(container: string, stage: string, runDir: string, jobAt: string, out: ScriptRan): ScriptRan {
  scriptDocker(["exec", container, "rm", "-rf", runDir, jobAt]);
  scriptHostDrop(stage);
  scriptRelease(container);
  return out;
}

let scriptRunSeq: int = 0;

export const SCRIPT_ENV_NAME_MAX: int = 40;

export function scriptEnvNameFault(name: string): string {
  if (name.length > SCRIPT_ENV_NAME_MAX) {
    return "an environment name is at most " + `${SCRIPT_ENV_NAME_MAX}`
      + " bytes of UTF-8; this one is " + `${name.length}`;
  }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
      || c == 46 || c == 45 || c == 95;
    if (!ok) {
      return "an environment name is letters, digits, dot, dash and underscore; nothing else names a container";
    }
    i = i + 1;
  }
  return "";
}

export function scriptRun(db: Db, run: ScriptRun): ScriptRan {
  if (run.threadId == "") {
    return scriptRefused("a script runs within a conversation, and this call names none");
  }
  let runtime = scriptRuntime(run.language);
  if (runtime == "") {
    return scriptRefused("run_script runs python, node or sh; \"" + run.language + "\" is not one of them");
  }
  if (run.source == "") {
    return scriptRefused("there is no script to run: source is empty");
  }
  if (run.language == "sh") {
    run = { language: run.language, threadId: run.threadId, agentId: run.agentId,
      source: run.source.replaceAll("<<'EOF\n", "<<'EOF'\n").replaceAll("<<\"EOF\n", "<<\"EOF\"\n"),
      paths: run.paths, mayCreate: run.mayCreate, environment: run.environment,
      turnSeq: run.turnSeq, now: run.now };
  }
  if (run.source.trim().startsWith("run_script(")) {
    return scriptRefused("source is the run_script(...) call itself, not a script: pass only the command to run — e.g. source=\"python skill.py 'query'\", not source=\"run_script(...)\"");
  }
  let envName = run.environment == "" ? "main" : run.environment;
  let named = scriptEnvNameFault(envName);
  if (named != "") {
    return scriptRefused(named);
  }
  let container = envContainerName(run.threadId, envName);

  let held = scriptAcquire(container, envName, run.now);
  if (held != "") {
    return scriptRefused(held);
  }

  scriptRunSeq = scriptRunSeq + 1;
  let id = scriptDigits(run.now) + "-" + `${scriptRunSeq}`;
  let stage = "/tmp/agents-script-" + id;
  let staged = scriptHostDir(stage + "/files");
  if (staged != "") {
    return scriptBail(container, stage, staged);
  }

  let snapshot = scriptMaterialise(db, run.threadId, run.paths, stage + "/files");
  let sn: int = 0;
  while (sn < snapshot.length) {
    if (!snapshot[sn].ok) {
      return scriptBail(container, stage, snapshot[sn].fault + " The script did not run.");
    }
    sn = sn + 1;
  }

  let ext = scriptExt(run.language);
  let job = scriptHostFile(stage + "/job." + ext, run.source);
  if (job != "") {
    return scriptBail(container, stage, job);
  }

  let before = envList(db, run.threadId);
  let known = false;
  let b: int = 0;
  while (b < before.length) {
    if (before[b].name == envName) {
      known = true;
    }
    b = b + 1;
  }
  let ownEnvId = "";
  let image = "";
  if (envName != "main") {
    let owner = scriptThreadOwner(db, run.threadId);
    if (owner != "") {
      let own = userEnvByName(db, owner, envName);
      if (own.id != "") {
        image = own.image;
        ownEnvId = own.id;
      }
    }
  }
  if (image == "") {
    image = scriptImageForEnv(db, run.agentId, envName);
  }
  if (image == "" && envName != "main") {
    return scriptBail(container, stage,
      "no environment answers to '" + envName + "' — it is one of your own environments' names, or one of the deployment's, and neither has it");
  }
  let ensure: EnvEnsure = {
    threadId: run.threadId,
    name: envName,
    image: image,
    network: true,
    now: run.now,
  };
  let ensured = envEnsure(db, ensure);
  if (!ensured.ok) {
    return scriptBail(container, stage, ensured.fault);
  }
  let recreated = known && ensured.created;

  let runDir = SCRIPT_RUN_DIR;
  let jobAt = "/tmp/lumen-job-" + id + "." + ext;
  scriptDocker(["exec", container, "rm", "-rf", runDir]);
  let placed = scriptDocker(["cp", stage + "/files", container + ":" + runDir]);
  if (placed.status != 0) {
    return scriptDone(container, stage, runDir, jobAt,
      scriptRanFlat(false, "", "", "", recreated, scriptDockerFailed("place the run directory", placed)));
  }
  let carried = scriptDocker(["cp", stage + "/job." + ext, container + ":" + jobAt]);
  if (carried.status != 0) {
    return scriptDone(container, stage, runDir, jobAt,
      scriptRanFlat(false, "", "", "", recreated, scriptDockerFailed("place the script", carried)));
  }

  let skillSet = scriptSkillRows(db, run.agentId);
  if (skillSet.length > 0) {
    let stagedSkills = scriptHostDir(stage + "/skills");
    if (stagedSkills != "") {
      return scriptDone(container, stage, runDir, jobAt, scriptRanFlat(false, "", "", "", recreated, stagedSkills));
    }
    let k: int = 0;
    while (k < skillSet.length) {
      let files = scriptSkillFiles(db, skillSet[k].id);
      let f: int = 0;
      while (f < files.length) {
        let dirMade = scriptHostDir(stage + "/skills/" + skillSet[k].skillName);
        if (dirMade != "") {
          return scriptDone(container, stage, runDir, jobAt, scriptRanFlat(false, "", "", "", recreated, dirMade));
        }
        let put = scriptHostFile(stage + "/skills/" + skillSet[k].skillName + "/" + files[f].path, files[f].body);
        if (put != "") {
          return scriptDone(container, stage, runDir, jobAt, scriptRanFlat(false, "", "", "", recreated, put));
        }
        f = f + 1;
      }
      k = k + 1;
    }
    scriptDocker(["exec", container, "rm", "-rf", "/skills"]);
    let placedSkills = scriptDocker(["cp", stage + "/skills", container + ":/skills"]);
    if (placedSkills.status != 0) {
      return scriptDone(container, stage, runDir, jobAt,
        scriptRanFlat(false, "", "", "", recreated, scriptDockerFailed("place the skill files", placedSkills)));
    }
  }

  let owned = scriptDocker(["exec", container, "chown", "-R", SCRIPT_UID, runDir]);
  if (owned.status != 0) {
    return scriptDone(container, stage, runDir, jobAt,
      scriptRanFlat(false, "", "", "", recreated, scriptDockerFailed("prepare the run directory", owned)));
  }

  let execArgs: string[] = ["exec", "--user", SCRIPT_UID, "--workdir", runDir];
  let owner = scriptThreadOwner(db, run.threadId);
  let imageId = ownEnvId != "" ? ownEnvId : scriptImageIdForEnv(db, run.agentId, envName);
  if (owner != "" && imageId != "") {
    let body = envKeyFileBody(db, owner, imageId, masterKey());
    if (body != "") {
      let keysAt = stage + "/env";
      let staged = scriptHostSecretFile(keysAt, body);
      if (staged != "") {
        return scriptBail(container, stage, staged);
      }
      execArgs.push("--env-file"); execArgs.push(keysAt);
      touchEnvKeys(db, owner, imageId, run.now);
    }
  }
  execArgs.push("-e"); execArgs.push("HOME=/workspace");
  execArgs.push("-e"); execArgs.push("PATH=/workspace/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
  execArgs.push(container);
  execArgs.push("timeout"); execArgs.push("-k"); execArgs.push(SCRIPT_KILL_GRACE);
  execArgs.push(`${scriptWallSeconds()}`); execArgs.push(runtime); execArgs.push(jobAt);
  let ran = scriptDocker(execArgs);

  let cap = scriptOutputMax();
  let sout = scriptCut(ran.stdout, cap);
  let serr = scriptCut(ran.stderr, cap);
  if (ran.status != 0) {
    return scriptDone(container, stage, runDir, jobAt,
      scriptRanFlat(false, sout, serr, scriptStopped(ran.status, runtime), recreated, ""));
  }
  if (sout.length != ran.stdout.length || serr.length != ran.stderr.length) {
    return scriptDone(container, stage, runDir, jobAt,
      scriptRanFlat(false, sout, serr,
        "the output cap of " + `${cap}` + " bytes of UTF-8; the prefix was kept and nothing was saved",
        recreated, ""));
  }

  let back = scriptDocker(["cp", container + ":" + runDir, stage + "/back"]);
  if (back.status != 0) {
    return scriptDone(container, stage, runDir, jobAt,
      scriptRanFlat(false, sout, serr, "", recreated, scriptDockerFailed("read the run directory back", back)));
  }
  let landed = scriptReconcile(db, {
    threadId: run.threadId, dir: stage + "/back", snapshot: snapshot,
    mayCreate: run.mayCreate, note: SCRIPT_NOTE, turnSeq: run.turnSeq, now: run.now,
  });
  let out: ScriptRan = {
    ok: landed.ok, stdout: sout, stderr: serr,
    changed: landed.changed, created: landed.created, unchanged: landed.unchanged,
    missing: landed.missing, refused: landed.refused,
    stopped: "", recreated: recreated, fault: landed.fault,
  };
  return scriptDone(container, stage, runDir, jobAt, out);
}

function scriptStopped(status: int, runtime: string): string {
  if (status == 124) {
    return "the wall-clock limit of " + `${scriptWallSeconds()}` + " seconds";
  }
  if (status == 127) {
    return "a missing runtime: this environment's image has no \"" + runtime + "\"";
  }
  return "exit status " + `${status}`;
}

function scriptRuntime(language: string): string {
  if (language == "python") {
    return "python3";
  }
  if (language == "node") {
    return "node";
  }
  if (language == "sh") {
    return "sh";
  }
  return "";
}

function scriptExt(language: string): string {
  if (language == "python") {
    return "py";
  }
  if (language == "node") {
    return "js";
  }
  return "sh";
}

function scriptDigits(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) {
      out = out + text.charAt(i);
    }
    i = i + 1;
  }
  return out == "" ? "0" : out;
}

function scriptSkillRows(db: Db, agentId: string): SkillRow[] {
  if (agentId == "") {
    let none: SkillRow[] = [];
    return none;
  }
  let where = "id IN (SELECT skill_id FROM agent_skills WHERE agent_id = " + placeholderAt(db, 1) + ")"
    + " OR visibility = 'public'";
  let document = listWhere(db, skillsMapping(), where, [agentId]);
  if (document == "" || document == "[]") {
    let none: SkillRow[] = [];
    return none;
  }
  return JSON.parse<SkillRow[]>(document);
}

function scriptSkillFiles(db: Db, skillId: string): SkillFileRow[] {
  let document = listWhere(db, skillFilesMapping(), "skill_id = " + placeholderAt(db, 1), [skillId]);
  if (document == "" || document == "[]") {
    let none: SkillFileRow[] = [];
    return none;
  }
  return JSON.parse<SkillFileRow[]>(document);
}

function scriptHostDir(dir: string): string {
  try {
    fs.mkdirSync(dir, true);
  } catch (e) {
    return "the run's staging directory could not be created";
  }
  return "";
}

function scriptHostFile(path: string, body: string): string {
  try {
    fs.writeFileSync(path, body);
  } catch (e) {
    return "the script could not be staged for the run";
  }
  return "";
}

function scriptHostSecretFile(path: string, body: string): string {
  let wrote = scriptHostFile(path, body);
  if (wrote != "") {
    return "the environment keys could not be staged for the run";
  }
  try {
    fs.chmodSync(path, 384);
  } catch (e) {
    return "the environment keys could not be staged for the run";
  }
  return "";
}

function scriptThreadOwner(db: Db, threadId: string): string {
  if (!db.query("SELECT owner FROM threads WHERE id = " + placeholderAt(db, 1), [threadId])) {
    return "";
  }
  if (db.rows() == 0) {
    return "";
  }
  return db.value(0, 0);
}

function scriptHostDrop(dir: string): void {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, true);
    }
  } catch (e) {
    return;
  }
}
