// The half of run_script that loses data if it is wrong: moving artifact
// bytes into a run directory and moving the run's changes back.
//
//   let snapshot = scriptMaterialise(db, threadId, ["/notes.md"], dir);
//   ... the script runs, rewriting files under dir ...
//   let done = scriptReconcile(db, { threadId: threadId, dir: dir,
//                                    snapshot: snapshot, mayCreate: false,
//                                    note: "run_script", turnSeq: seq, now: now });
//
// Materialise writes each named path's newest version into the directory at
// its own relative path; the returned list is the snapshot — which version
// each file started from — and reconcile is a comparison against exactly that.
// A byte-identical file mints no version. A changed file appends one through
// the same validation putArtifact applies, with an explicit INSERT at
// snapshot+1 so a version that moved mid-run is refused rather than buried
// (the artifacts-edit.ts idiom, minus the retry: an edit can re-match against
// the winner's body, but a script's output was computed from the snapshot and
// replaying it on a newer base is exactly the stale overwrite the
// precondition exists to refuse). A file missing from the directory is
// reported and nothing else — a run deletes nothing, ever. A new file needs
// mayCreate, and lands through putArtifact so a script cannot reach a path a
// write_artifact could not.
//
// The directory here is a plain directory, and nothing in the materialise/
// reconcile half knows docker exists. The run half further down (RUN-SCRIPT.md,
// build order steps 3 and 4) is what drives the docker CLI: it stages such a
// directory on the host, copies it into the conversation's container, execs
// the script under its caps, copies the run directory back and reconciles it
// here — with the ceilings refusing, never queueing, in front of all of it.
//
// No failure path below throws. The fs calls that can throw are held inside
// their own try in the function that makes them — a throw does not cross a
// lambda, so nothing above the dispatch loop could catch one — and failure is
// a returned `problem` sentence, in putArtifact's refusal() idiom.
//
//   cd packages/agents && lumen test run-script.test.ts

import { Db } from "../plume/driver.ts";
import { executeWith, findById, listWhere, placeholderAt, beginTransaction, commitTransaction, rollbackTransaction } from "../plume/plume.ts";
import { ARTIFACT_MAX, ARTIFACT_NOTE_MAX, THREAD_BYTES_MAX, binaryKind, getArtifact, getVersion, kindOf, labelProblem, nextVersion, putArtifact, threadBytes, utf8Length } from "./artifacts.ts";
import { EnvDockerReply, EnvEnsure, envContainerName, envDockerBin, envEnsure, envList } from "./environments.ts";
import { normalScope } from "./knowledge.ts";
import { AgentRow, ScriptImageRow, SkillRow, SkillFileRow, agentsMapping, scriptImagesMapping, skillsMapping, skillFilesMapping } from "./schema.ts";

// One materialised path: which version the run directory holds, or why it
// holds nothing. The list of these IS the snapshot reconcile compares against
// — path and version together are the precondition for landing a change.
export type ScriptFile = {
  path: string,
  version: int,
  ok: bool,
  problem: string,
};

// What one reconcile is asked to do. A record and not six positional
// arguments: three strings in a row, and `note` sitting where `dir` belongs
// would file an audit comment as the directory to walk.
export type ScriptReconcile = {
  threadId: string,
  // The run directory the script wrote into. Walked, never escaped: every
  // artifact path is relative to it, and a symbolic link inside it is refused
  // unread — a script that plants one is asking the reconcile to read a file
  // the run was never given.
  dir: string,
  // What scriptMaterialise returned before the run. Entries that were not ok
  // never reached the directory and are ignored here.
  snapshot: ScriptFile[],
  // Whether files the snapshot does not name may become new artifacts.
  mayCreate: bool,
  // The note every version this reconcile appends will carry. "" is fine.
  note: string,
  turnSeq: int,
  now: string,
};

// A path and the version this reconcile left it at.
export type ScriptVersioned = {
  path: string,
  version: int,
};

// A path this reconcile would not land, and the sentence saying why.
export type ScriptRefusal = {
  path: string,
  problem: string,
};

// The reconcile's whole answer. `ok` is about the walk itself — a missing or
// unreadable run directory — never about any one path: a per-path failure is
// a ScriptRefusal, and the other paths still land.
export type ScriptReconciled = {
  ok: bool,
  changed: ScriptVersioned[],
  created: ScriptVersioned[],
  unchanged: ScriptVersioned[],
  // Snapshot paths with no file left in the directory. Reported and nothing
  // more: a run deletes nothing, so "the script removed it" is information
  // for the model, not an instruction to the database.
  missing: string[],
  refused: ScriptRefusal[],
  problem: string,
};

// --- materialise ------------------------------------------------------------------

// Write each named path's newest version into `dir` at its own relative path,
// creating parent directories on the way. One entry per requested path, in
// request order; a path that is not an artifact of this thread is refused by
// name and writes nothing. Whether a refused path aborts the whole run is the
// caller's decision (RUN-SCRIPT.md says it does), so the list reports every
// path rather than stopping at the first.
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
  let out: ScriptFile = { path: path, version: 0, ok: false, problem: why };
  return out;
}

function materialiseOne(db: Db, threadId: string, raw: string, dir: string): ScriptFile {
  let path = normalScope(raw);
  if (threadId == "") { return fileRefusal(path, "an artifact belongs to a thread"); }
  let artifact = getArtifact(db, threadId, path);
  if (artifact.id == "") {
    // read_artifact's sentence, so the two doors describe absence identically.
    return fileRefusal(path, "There is no artifact at " + path + " in this conversation.");
  }
  // The pointer's version, and the refusal when the pointer is broken — the
  // edit door's rule (artifacts-edit.ts): a pointer naming a version the log
  // lacks is a state to surface, not to paper over with MAX(version).
  let current = getVersion(db, artifact.id, artifact.currentVersion);
  if (current.id == "") {
    return fileRefusal(path, "Artifact " + path + " points at version "
      + `${artifact.currentVersion}` + ", which is not in its history.");
  }
  let placed = placeFile(dir, path, current.body);
  if (placed != "") { return fileRefusal(path, placed); }
  let out: ScriptFile = { path: path, version: artifact.currentVersion, ok: true, problem: "" };
  return out;
}

// Write one body under the run directory, parents first. "" on success. The
// try is here, around the only fs writes materialise makes, because a throw
// would not cross the lambda the dispatch loop will one day call this from.
function placeFile(dir: string, path: string, body: string): string {
  let cut = path.lastIndexOf("/");
  let parent = dir + path.slice(0, cut);
  try {
    fs.mkdirSync(parent, true);
    if (binaryKind(kindOf(path))) {
      // The stored body is base64; the script wants the real bytes. Decoded
      // through sh only because base64 -d reads stdin — the paths here are
      // the run dir (ours) and an artifact path (whose charset has no quote
      // to escape), so the single-quoted words below cannot be broken out of.
      fs.writeFileSync(dir + path + ".b64", body);
      let dec = child_process.spawnSync("sh", ["-c",
        "base64 -d < '" + dir + path + ".b64' > '" + dir + path + "' && rm '" + dir + path + ".b64'"]);
      if (dec.status != 0) { return "could not decode " + path + " into the run directory"; }
    } else {
      fs.writeFileSync(dir + path, body);
    }
  } catch (e) {
    return "could not write " + path + " into the run directory";
  }
  return "";
}

// --- the walk -------------------------------------------------------------------

// What the walk over the run directory found: regular files and symbolic
// links as artifact-shaped relative paths, or the sentence for a directory
// that could not be read at all.
type ScriptWalk = {
  files: string[],
  links: string[],
  problem: string,
};

function walkFailed(): ScriptWalk {
  let files: string[] = [];
  let links: string[] = [];
  let out: ScriptWalk = {
    files: files, links: links,
    problem: "the run directory could not be read; nothing was reconciled",
  };
  return out;
}

// Walk one directory level, names sorted so the reply's order never depends
// on readdir's. Regular files and links accumulate as "/relative/paths";
// directories recurse, their results folded into this level's. Accumulation
// is by return value, not through a shared parameter — an array pushed
// through a parameter stays the callee's copy here. A file the script
// replaced with a directory is simply not in `files`, so it reports as
// missing — and whatever is inside arrives as new files, each facing the
// create gate on its own.
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
      if (sub.problem != "") { return sub; }
      let f: int = 0;
      while (f < sub.files.length) { files.push(sub.files[f]); f = f + 1; }
      let l: int = 0;
      while (l < sub.links.length) { links.push(sub.links[l]); l = l + 1; }
    } else if (entry == "gone") {
      return walkFailed();
    }
    i = i + 1;
  }
  let out: ScriptWalk = { files: files, links: links, problem: "" };
  return out;
}

// One directory entry: "file", "link", "dir", "gone" for an entry that could
// not be examined, or "" for anything else (a socket, a fifo — nothing a
// reconcile could store anyway). Its own function so the try around the fs
// calls sits next to them.
function classifyEntry(base: string, path: string): string {
  try {
    // readlink answers "" for anything that is not a symbolic link, so this
    // is the link test — stat follows links, which is exactly what must not
    // decide here.
    if (fs.readlinkSync(base + path) != "") { return "link"; }
    let st = fs.statSync(base + path);
    if (st.isDirectory) { return "dir"; }
    if (st.isFile) { return "file"; }
  } catch (e) {
    return "gone";
  }
  return "";
}

// --- reconcile --------------------------------------------------------------------

// What one path's reconcile amounted to. `kind` is one of "changed",
// "created", "unchanged" or "refused"; version rides the first three,
// problem the last. Returned rather than pushed into the caller's record,
// because record fields are immutable here — accumulation happens in local
// arrays at the top.
type ScriptOutcome = {
  kind: string,
  path: string,
  version: int,
  problem: string,
};

function outcomeLanded(kind: string, path: string, version: int): ScriptOutcome {
  let out: ScriptOutcome = { kind: kind, path: path, version: version, problem: "" };
  return out;
}

function outcomeRefused(path: string, why: string): ScriptOutcome {
  let out: ScriptOutcome = { kind: "refused", path: path, version: 0, problem: why };
  return out;
}

function reconcileProblem(why: string): ScriptReconciled {
  let changed: ScriptVersioned[] = [];
  let created: ScriptVersioned[] = [];
  let unchanged: ScriptVersioned[] = [];
  let missing: string[] = [];
  let refused: ScriptRefusal[] = [];
  let out: ScriptReconciled = {
    ok: false, changed: changed, created: created, unchanged: unchanged,
    missing: missing, refused: refused, problem: why,
  };
  return out;
}

// Compare every file now in the run directory against the snapshot and land
// the differences, path by path, each in its own transaction — one refused
// path never holds another's version hostage.
export function scriptReconcile(db: Db, run: ScriptReconcile): ScriptReconciled {
  if (run.threadId == "") { return reconcileProblem("an artifact belongs to a thread"); }
  let badNote = labelProblem("note", run.note, ARTIFACT_NOTE_MAX);
  if (badNote != "") { return reconcileProblem(badNote); }
  if (!fs.existsSync(run.dir)) {
    // The whole directory gone is not "every file deleted" — reporting it
    // that way would tell the model the run removed work it never touched.
    return reconcileProblem("the run directory is gone; nothing was reconciled");
  }

  let walked = walkRun(run.dir, "");
  if (walked.problem != "") { return reconcileProblem(walked.problem); }
  let files = walked.files;
  let links = walked.links;

  let changed: ScriptVersioned[] = [];
  let created: ScriptVersioned[] = [];
  let unchanged: ScriptVersioned[] = [];
  let missing: string[] = [];
  let refused: ScriptRefusal[] = [];

  // Every regular file, known paths against their snapshot version and new
  // ones through the create gate. The walk sorted each level, so the reply
  // lists paths in one stable order.
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
      let no: ScriptRefusal = { path: outcome.path, problem: outcome.problem };
      refused.push(no);
    }
    i = i + 1;
  }

  // A symbolic link is refused unread, wherever it points: following one
  // would store bytes from a file the run was never given, under a path the
  // conversation trusts.
  let ln: int = 0;
  while (ln < links.length) {
    let linked: ScriptRefusal = {
      path: links[ln],
      problem: links[ln] + " is a symbolic link, and a run may only save regular files",
    };
    refused.push(linked);
    ln = ln + 1;
  }

  // Snapshot paths with nothing left in the directory. Reported, never acted
  // on: deletion does not propagate, by design. The listedIn(missing, ...)
  // check keeps a duplicated snapshot entry from reporting twice.
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
    missing: missing, refused: refused, problem: "",
  };
  return out;
}

// The snapshot entry for a path, or -1. Only ok entries count: a path that
// was refused at materialise never reached the directory, so a file there now
// is the script's creation, not a change.
function snapshotAt(snapshot: ScriptFile[], path: string): int {
  let i: int = 0;
  while (i < snapshot.length) {
    if (snapshot[i].ok && snapshot[i].path == path) { return i; }
    i = i + 1;
  }
  return -1;
}

function listedIn(list: string[], path: string): bool {
  let i: int = 0;
  while (i < list.length) {
    if (list[i] == path) { return true; }
    i = i + 1;
  }
  return false;
}

// --- reading the run directory back -----------------------------------------------

type ScriptRead = {
  ok: bool,
  body: string,
};

// A file's size without reading it, or -1. The try sits here, beside the call.
function sizeOf(path: string): int {
  try {
    let st = fs.statSync(path);
    return st.size;
  } catch (e) {
    return -1;
  }
}

// A file's bytes, or ok: false — never a throw, for the lambda rule above.
//
// An image is the exception to "read it as a string": a PNG is not UTF-8 and
// a Lumen string is, so raster files are carried as base64 from the moment
// they leave the run directory. The encoding is the system base64 binary via
// spawnSync — an argv vector, no shell — because the runtime has no byte
// array to hold the raw form in.
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

// --- the version-preconditioned append --------------------------------------------

type ScriptAppend = {
  threadId: string,
  path: string,
  body: string,
  // The version the run directory's copy came from — the precondition.
  baseVersion: int,
  note: string,
  turnSeq: int,
  now: string,
};

type ScriptAppended = {
  ok: bool,
  version: int,
  problem: string,
};

function appendRefusal(why: string): ScriptAppended {
  let out: ScriptAppended = { ok: false, version: 0, problem: why };
  return out;
}

// Both versions in one sentence, because the model's next move needs both:
// what it computed from, and what stands now.
function movedRefusal(path: string, base: int, newest: int): ScriptAppended {
  return appendRefusal("the newest version of " + path + " moved from " + `${base}`
    + " to " + `${newest}` + " while the script ran; its change was not saved — "
    + "read the current version and apply the change again");
}

// Append `body` at exactly baseVersion + 1, or refuse. The editAttempt idiom
// (artifacts-edit.ts) without the retry: the INSERT lands at base+1 and the
// unique index on (artifact_id, version) from migration 53 is the
// compare-and-swap, so a concurrent append makes the INSERT fail — and here
// that is a refusal naming both versions, never a retry on the newer base,
// because this body was computed from the snapshot and knows nothing about
// what the winner wrote.
function scriptAppend(db: Db, append: ScriptAppend): ScriptAppended {
  // putArtifact's byte checks, in putArtifact's words, so the model learns
  // the same rule whichever door refused it.
  let bytes = utf8Length(append.body);
  if (bytes > ARTIFACT_MAX) {
    return appendRefusal("an artifact is at most " + `${ARTIFACT_MAX}` + " bytes; this one is " + `${bytes}`);
  }

  let opened = beginTransaction(db);
  if (!opened.ok) { return appendRefusal("the change to " + append.path + " could not be saved; try again"); }

  let artifact = getArtifact(db, append.threadId, append.path);
  if (artifact.id == "") {
    rollbackTransaction(db);
    // Deleted while the script ran. Recreating it would resurrect what
    // someone deliberately removed, so the change stays unlanded.
    return appendRefusal("There is no artifact at " + append.path + " in this conversation.");
  }

  // The log's MAX, not the pointer: the pointer is a cache and this check is
  // the precondition, so it reads the same truth the unique index defends.
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

  // Explicit INSERT at exactly base+1, never `persist`: persist upserts, and
  // an upsert on the append-only log is a silent overwrite (artifacts.ts:529).
  let version = append.baseVersion + 1;
  let wrote = executeWith(db,
    "INSERT INTO artifact_versions (id, artifact_id, version, body, bytes, origin, turn_seq, note, created_at) VALUES ("
    + placeholderAt(db, 1) + ", " + placeholderAt(db, 2) + ", " + placeholderAt(db, 3) + ", "
    + placeholderAt(db, 4) + ", " + placeholderAt(db, 5) + ", " + placeholderAt(db, 6) + ", "
    + placeholderAt(db, 7) + ", " + placeholderAt(db, 8) + ", " + placeholderAt(db, 9) + ")",
    [artifact.id + ":" + `${version}`, artifact.id, `${version}`, append.body, `${bytes}`,
     // Fixed, not read from anywhere: a script's output is the model writing.
     "generated", `${append.turnSeq}`, append.note, append.now]);
  if (!wrote.ok) {
    rollbackTransaction(db);
    // Someone landed base+1 between the check above and this INSERT. The
    // refusal re-reads what stands now so the sentence names both versions.
    let raced = nextVersion(db, artifact.id);
    let standing = raced < 2 ? append.baseVersion + 1 : raced - 1;
    return movedRefusal(append.path, append.baseVersion, standing);
  }

  // A column-scoped UPDATE of the pointer, never a full-row persist — a
  // full-row persist is how the rotate bug once rewound a pointer and
  // orphaned a version (api.ts:1351). Title, kind, mime, slot and
  // previewToken are untouched: a reconcile has no opinion about metadata.
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
  let out: ScriptAppended = { ok: true, version: version, problem: "" };
  return out;
}

// --- landing one path -------------------------------------------------------------

// A snapshot path: identical bytes mint nothing, changed bytes append at
// exactly snapshot+1.
function reconcileKnown(db: Db, run: ScriptReconcile, snap: ScriptFile): ScriptOutcome {
  // Size before body: a script can grow a file without bound, and the cap
  // should refuse it without reading half a gigabyte into a string first.
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
    // Byte-identical with what the run started from: nothing happened to this
    // file, so nothing is written — even when the artifact moved on
    // underneath, because there is no change to conflict with.
    return outcomeLanded("unchanged", snap.path, snap.version);
  }

  let landed = scriptAppend(db, {
    threadId: run.threadId, path: snap.path, body: read.body,
    baseVersion: snap.version, note: run.note, turnSeq: run.turnSeq, now: run.now,
  });
  if (!landed.ok) {
    return outcomeRefused(snap.path, landed.problem);
  }
  return outcomeLanded("changed", snap.path, landed.version);
}

// A path the snapshot does not name. Through putArtifact with mustCreate, so
// a script faces every rule write_artifact does — and cannot append to an
// artifact the run never materialised, because there is no snapshot version
// to precondition that append on.
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
    return outcomeRefused(path, put.problem);
  }
  return outcomeLanded("created", path, put.version);
}

// --- the run itself ---------------------------------------------------------------
//
// scriptRun is materialise -> run -> reconcile with a container in the middle.
// The container is the conversation's environment (environments.ts), reached
// through the same envDockerBin seam, so one fake binary stands in for the
// daemon across both modules.
//
// The run directory travels by `docker cp` of a staged host directory, not by
// a bind mount: a mount is a creation-time property of a container, and the
// container here is created once per conversation and lives across runs — a
// fresh per-run mount would mean a fresh per-run container, which is exactly
// what the environment model rejects. cp also keeps host paths out of the
// container's view entirely.
//
// The wall clock is coreutils `timeout` inside the exec — the spec's "exec
// timeout" option. Killing the docker *client* from the host would leave the
// script running in the container, and `docker kill` would take the whole
// environment down with it (the keep-alive `sleep infinity` is pid 1). The
// default image is Debian-based, so `timeout` is present.

// What every environment is built from. Python and sh out of the box; a node
// script in this image stops with "no node runtime", which is the failure
// table's answer until per-language images arrive with network environments.
// The runtime image: python AND node with the system libraries the common
// packages need at run time (cairo, pango, pixbuf), built from the Dockerfile
// beside RUN-SCRIPT.md. python:3.12-slim alone was a trap a real model walked
// straight into — it offered node in the tool description and had no node,
// and every cairo-backed package imported fine and died at load.
// AGENTS_SCRIPT_IMAGE overrides for a deployment that builds its own.
export function scriptImage(): string {
  return process.env("AGENTS_SCRIPT_IMAGE") ?? "agents-runtime:1";
}

// The image THIS agent's environments are built from: its curated choice, or
// the deployment default when it has none.
//
// Resolved from the agent's row rather than taken from the call, and never
// from the model: a run_script that could name its own image would let a
// sentence in a retrieved document make this server pull an arbitrary image
// off the internet and run it. The operator curates script_images; an agent
// points at one; a conversation inherits whatever its agent had when its
// container was created.
//
// A disabled or missing row falls back to the default rather than refusing —
// an operator retiring an image should not break every conversation that
// pointed at it, and the fallback is a working image by definition.
// A named environment picks its image by name: "office" runs in the curated
// row whose label lowercases to "office". The list stays the operator's —
// a name with no enabled row refuses rather than falling back, because the
// fallback would be a skill silently running without the libraries its
// briefing promised. "main" keeps the agent's own image, which is the whole
// pre-environment behaviour unchanged.
export function scriptImageForEnv(db: Db, agentId: string, envName: string): string {
  if (envName == "" || envName == "main") { return scriptImageFor(db, agentId); }
  let rows = JSON.parse<ScriptImageRow[]>(listWhere(db, scriptImagesMapping(), "enabled = " + placeholderAt(db, 1), ["1"]));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].label.toLowerCase() == envName && rows[i].image != "") { return rows[i].image; }
    i = i + 1;
  }
  return "";
}

export function scriptImageFor(db: Db, agentId: string): string {
  if (agentId == "") { return scriptImage(); }
  let held = findById(db, agentsMapping(), agentId);
  if (held == "") { return scriptImage(); }
  let chosen = JSON.parse<AgentRow>(held).scriptImageId;
  if (chosen == "") { return scriptImage(); }
  let row = findById(db, scriptImagesMapping(), chosen);
  if (row == "") { return scriptImage(); }
  let image: ScriptImageRow = JSON.parse<ScriptImageRow>(row);
  if (!image.enabled || image.image == "") { return scriptImage(); }
  return image.image;
}

// How many scripts the whole deployment may run at once. Well below the HTTP
// pool size on purpose: a script holds its handler thread for the entire run,
// and the API must keep answering — including the steps poll that draws the
// card showing the script run.
export const SCRIPT_MAX_RUNNING: int = 2;

// The wall clock, and how much output each stream may bring back. Bytes of
// UTF-8, like every cap in this package.
export const SCRIPT_WALL_SECONDS: int = 60;
export const SCRIPT_OUTPUT_MAX: int = 65536;

// The unprivileged user a script runs as. Numeric, not a name, so it holds in
// any image whether or not /etc/passwd has a row for it.
// Scripts run as root INSIDE the container — an isolated, per-conversation,
// unprivileged container is the boundary, not the uid — because a real model
// reaches for apt-get within its first few steps and "Permission denied" as
// nobody turned a solvable problem into a burned step budget. The host is
// protected by the container, not by the uid inside it.
const SCRIPT_UID: string = "0:0";

// Seconds between timeout's TERM and its KILL, for a script that ignores TERM.
const SCRIPT_KILL_GRACE: string = "5";

// Where a run's artifacts are, inside the container. One known path, named in
// the tool's own description, and the script's working directory besides.
//
// It used to be /tmp/lumen-run-<id>, unguessable by construction, which was
// fine while the only thing that had to find it was this package. It is not
// fine for the model: an agent handed an uploaded docflow spent every step it
// had guessing where the file was — the artifact path, /tmp, /workspace, /app,
// a made-up /artifacts/1/1 — and one small model, unable to find the file it
// was asked to repair, wrote a plausible docflow of its own instead and
// validated that. A path a model can be told once and rely on is worth more
// than a path no collision can reach.
//
// Fixed is safe here because RUN-SCRIPT.md already forbids the collision: one
// script at a time per environment, and no two conversations share a
// container. The directory is still made fresh for every run — the guarantee
// that matters is that it holds this run's artifacts and nothing stale, not
// that its name is unique.
export const SCRIPT_RUN_DIR: string = "/artifacts";

// The note every version a run appends carries.
const SCRIPT_NOTE: string = "run_script";

// Test seams for the two per-run caps, in the envDockerOverride idiom: a test
// cannot set an environment variable in-process and cannot wait a minute for
// a real wall clock. Zero means "the constant".
let scriptWallChosen: int = 0;
export function scriptWallOverride(seconds: int): void { scriptWallChosen = seconds; }
function scriptWallSeconds(): int {
  return scriptWallChosen > 0 ? scriptWallChosen : SCRIPT_WALL_SECONDS;
}

let scriptOutputChosen: int = 0;
export function scriptOutputOverride(bytes: int): void { scriptOutputChosen = bytes; }
function scriptOutputMax(): int {
  return scriptOutputChosen > 0 ? scriptOutputChosen : SCRIPT_OUTPUT_MAX;
}

// --- the docker probe -------------------------------------------------------------

// Whether docker is present and its daemon answers, asked once per process
// and remembered. This is the gate on offering the tool at all: absent or
// broken means run_script never appears in a tool list, because a model
// cannot call a tool it was never told about (RUN-SCRIPT.md's last rule).
let scriptProbed: int = -1;

export function scriptProbeReset(): void { scriptProbed = -1; }

export function scriptDockerWorks(): bool {
  if (scriptProbed < 0) {
    let asked = scriptDocker(["info"]);
    scriptProbed = asked.status == 0 ? 1 : 0;
  }
  return scriptProbed == 1;
}

// The same one-door rule as envDocker: an argument vector through the same
// seam, never a shell string, so nothing a model writes can be quoted into a
// command — and a missing binary is status -1, never a throw.
function scriptDocker(args: string[]): EnvDockerReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let reply: EnvDockerReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return reply;
}

function scriptDockerFailed(doing: string, reply: EnvDockerReply): string {
  let line = scriptFirstLine(reply.stderr);
  if (line == "") { line = scriptFirstLine(reply.stdout); }
  if (line == "") { return "docker could not " + doing + " (docker itself did not run)"; }
  return "docker could not " + doing + ": " + scriptCut(line, 200);
}

function scriptFirstLine(text: string): string {
  let end: int = 0;
  while (end < text.length && text.charCodeAt(end) != 10 && text.charCodeAt(end) != 13) {
    end = end + 1;
  }
  return text.slice(0, end).trim();
}

// A byte-capped prefix that never ends mid-character: the cut walks back off
// any UTF-8 continuation byte, the same care argsPreview takes.
function scriptCut(text: string, cap: int): string {
  if (text.length <= cap) { return text; }
  let cut = cap;
  while (cut > 0) {
    let b = text.charCodeAt(cut);
    if (b < 128 || b >= 192) { break; }
    cut = cut - 1;
  }
  return text.slice(0, cut);
}

// --- the ceilings -----------------------------------------------------------------
//
// Module state, and deliberately a string rather than an array: a string
// reassigned whole is the one kind of module-level mutation this codebase has
// proven across calls (envChosenDocker). One line per running script,
// "container since", newline-terminated; container names are docker's
// character set, so the space is a safe delimiter.
//
// Both ceilings refuse and never queue: a queue built from blocked handler
// threads is the same exhaustion with a longer name (RUN-SCRIPT.md). The
// per-environment lock is per *container name* — two conversations never
// share one, so the cross-thread race this guards is structural already; what
// it stops is one conversation's second script racing its first.

let scriptHeldNow: string = "";

function scriptHeldLines(): string[] {
  let out: string[] = [];
  if (scriptHeldNow == "") { return out; }
  let parts = scriptHeldNow.split("\n");
  let i: int = 0;
  while (i < parts.length) {
    if (parts[i] != "") { out.push(parts[i]); }
    i = i + 1;
  }
  return out;
}

export function scriptRunningCount(): int {
  return scriptHeldLines().length;
}

// Claim a slot for one run in `container`, or say why not. "" means claimed,
// and the caller owes a scriptRelease on every path out.
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
    if (key != container) { out = out + held[i] + "\n"; }
    i = i + 1;
  }
  scriptHeldNow = out;
}

// --- one run ----------------------------------------------------------------------

// What one run is asked to do. A record for the same reason ScriptReconcile
// is: language, source and environment are three strings in a row, and
// swapped positionally nothing would refuse them.
export type ScriptRun = {
  threadId: string,
  // "python", "node" or "sh" — anything else is refused naming those three.
  language: string,
  // The program, verbatim. Untrusted model output: it reaches the container
  // as a file and an argv entry, never a shell string.
  source: string,
  // The artifacts to materialise, explicit, never "all". A path that is not
  // an artifact of this thread refuses the whole call before any container
  // exists.
  paths: string[],
  mayCreate: bool,
  // Which environment runs it; "" means "main".
  environment: string,
  // Whose curated image to build the container from. The agent's id, not an
  // image reference: the choice belongs to configuration, never to the call.
  agentId: string,
  turnSeq: int,
  now: string,
};

// The whole answer. stdout and stderr come back always — especially on
// failure, they are how the model learns what its program did. `stopped`
// names what ended a run early ("" when it completed); `problem` is the
// sentence for a call that was refused or broke before or after the script
// itself. `recreated` says the environment came back cold: its workspace
// cache is gone, and the reply must say so (RUN-SCRIPT.md failure table).
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
  problem: string,
};

// Every list empty; the scalar outcomes as given.
function scriptRanFlat(ok: bool, stdout: string, stderr: string, stopped: string, recreated: bool, problem: string): ScriptRan {
  let changed: ScriptVersioned[] = [];
  let created: ScriptVersioned[] = [];
  let unchanged: ScriptVersioned[] = [];
  let missing: string[] = [];
  let refused: ScriptRefusal[] = [];
  let out: ScriptRan = {
    ok: ok, stdout: stdout, stderr: stderr, changed: changed, created: created,
    unchanged: unchanged, missing: missing, refused: refused,
    stopped: stopped, recreated: recreated, problem: problem,
  };
  return out;
}

function scriptRefused(why: string): ScriptRan {
  return scriptRanFlat(false, "", "", "", false, why);
}

// A refusal after the slot was claimed but before the container was touched.
function scriptBail(container: string, stage: string, why: string): ScriptRan {
  scriptHostDrop(stage);
  scriptRelease(container);
  return scriptRefused(why);
}

// The way out once the container holds run debris: best-effort removal of the
// run directory and the script (failure ignored — the next run uses fresh
// names, and the reaper for a hoarding workspace is the disk quota), the host
// stage dropped, the slot released.
function scriptDone(container: string, stage: string, runDir: string, jobAt: string, out: ScriptRan): ScriptRan {
  scriptDocker(["exec", container, "rm", "-rf", runDir, jobAt]);
  scriptHostDrop(stage);
  scriptRelease(container);
  return out;
}

// Distinguishes runs within one millisecond stamp; reassigned module state,
// like the ceiling ledger.
let scriptRunSeq: int = 0;

// Materialise the named artifacts, run the script in the conversation's
// environment, reconcile what came back. Every refusal is a sentence, never a
// throw, and the order below is a promise: everything that can refuse a call
// outright — arguments, ceilings, the artifacts themselves — refuses before
// any container is created, so a refused call never mints an environment.
// An environment name is part of a container's name, so it is refused rather
// than sanitised: two different names that sanitise alike would silently share
// a container, which is the cross-environment contamination the model was
// promising to avoid by naming one. The charset is the container charset, and
// the cap is bytes of UTF-8 and says so — a name written outside ASCII counts
// more than one per letter, and a refusal that said "characters" would hand
// the model arithmetic it cannot reproduce.
export const SCRIPT_ENV_NAME_MAX: int = 40;

export function scriptEnvNameProblem(name: string): string {
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
  // An empty paths list is an install-only run: nothing materialised, nothing
  // to reconcile against, and mayCreate still gates anything the script
  // leaves behind. Refusing this cost a real model two steps of its budget
  // retrying pip install with paths it did not have.
  let envName = run.environment == "" ? "main" : run.environment;
  let named = scriptEnvNameProblem(envName);
  if (named != "") { return scriptRefused(named); }
  let container = envContainerName(run.threadId, envName);

  let held = scriptAcquire(container, envName, run.now);
  if (held != "") { return scriptRefused(held); }

  scriptRunSeq = scriptRunSeq + 1;
  let id = scriptDigits(run.now) + "-" + `${scriptRunSeq}`;
  let stage = "/tmp/agents-script-" + id;
  let staged = scriptHostDir(stage + "/files");
  if (staged != "") { return scriptBail(container, stage, staged); }

  // Materialise before the environment exists: it needs no docker, and every
  // artifact refusal must land while there is still nothing to pay for.
  let snapshot = scriptMaterialise(db, run.threadId, run.paths, stage + "/files");
  let sn: int = 0;
  while (sn < snapshot.length) {
    if (!snapshot[sn].ok) {
      return scriptBail(container, stage, snapshot[sn].problem + " The script did not run.");
    }
    sn = sn + 1;
  }

  let ext = scriptExt(run.language);
  let job = scriptHostFile(stage + "/job." + ext, run.source);
  if (job != "") { return scriptBail(container, stage, job); }

  // Whether the environment's row existed before this call, because envEnsure
  // reports `created` for a first use and for a recreation alike — and only
  // one of those lost a workspace the conversation had built.
  let before = envList(db, run.threadId);
  let known = false;
  let b: int = 0;
  while (b < before.length) {
    if (before[b].name == envName) { known = true; }
    b = b + 1;
  }
  // With the network: the whole point of a persistent container is what a
  // script installs into it, and an installer with nowhere to fetch from is
  // decoration. Creation-time only — the row records it, a script cannot
  // flip it.
  let image = scriptImageForEnv(db, run.agentId, envName);
  if (image == "" && envName != "main") {
    return scriptBail(container, stage,
      "no curated image is labelled '" + envName + "' — environments are named after the operator's script images, and this deployment does not offer that one");
  }
  let ensure: EnvEnsure = { threadId: run.threadId, name: envName, image: image, network: true, now: run.now };
  let ensured = envEnsure(db, ensure);
  if (!ensured.ok) { return scriptBail(container, stage, ensured.problem); }
  let recreated = known && ensured.created;

  // The staged directory becomes the run directory inside the container, and
  // the script lands beside it — never inside, or the reconcile's walk would
  // meet it as a file the run "created".
  let runDir = SCRIPT_RUN_DIR;
  let jobAt = "/tmp/lumen-job-" + id + "." + ext;
  // A run that crashed hard enough to skip its cleanup would otherwise leave
  // its files here, and `docker cp` into an existing directory nests rather
  // than replaces — /artifacts/files. Cleared first, so the directory a script
  // meets holds this run's artifacts and nothing else.
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

  // The agent's skill files, at /skills/<skill-name>/<path> — the path each
  // skill's body promises. Staged fresh on every run, the artifact staleness
  // rule: an edit to a skill file is what the very next run executes, and a
  // script that scribbled over /skills damaged one run, not the environment.
  // Outside the run directory on purpose, so the reconcile's walk never meets
  // a skill file as something the run "created".
  let skillSet = scriptSkillRows(db, run.agentId);
  if (skillSet.length > 0) {
    let stagedSkills = scriptHostDir(stage + "/skills");
    if (stagedSkills != "") { return scriptDone(container, stage, runDir, jobAt, scriptRanFlat(false, "", "", "", recreated, stagedSkills)); }
    let k: int = 0;
    while (k < skillSet.length) {
      let files = scriptSkillFiles(db, skillSet[k].id);
      let f: int = 0;
      while (f < files.length) {
        let dirMade = scriptHostDir(stage + "/skills/" + skillSet[k].skillName);
        if (dirMade != "") { return scriptDone(container, stage, runDir, jobAt, scriptRanFlat(false, "", "", "", recreated, dirMade)); }
        let put = scriptHostFile(stage + "/skills/" + skillSet[k].skillName + "/" + files[f].path, files[f].body);
        if (put != "") { return scriptDone(container, stage, runDir, jobAt, scriptRanFlat(false, "", "", "", recreated, put)); }
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

  // docker cp leaves root ownership; the script runs unprivileged and must be
  // able to write its own run directory.
  let owned = scriptDocker(["exec", container, "chown", "-R", SCRIPT_UID, runDir]);
  if (owned.status != 0) {
    return scriptDone(container, stage, runDir, jobAt,
      scriptRanFlat(false, "", "", "", recreated, scriptDockerFailed("prepare the run directory", owned)));
  }

  // HOME is /workspace — writable, owned by the run user, and OUTSIDE the
  // per-run directory, so `pip install` and `npm install -g` land somewhere
  // that persists between runs. That is the point of the environment: the
  // second script finds what the first one installed.
  //
  // `language` picks an interpreter and constrains nothing else: a python
  // script may shell out, change directory, apt-get and curl, deliberately.
  // The guard rails are the container's — capabilities dropped to the few
  // apt and pip need, no-new-privileges so nothing inside can regain the
  // rest, and the memory/cpu/pid caps on the container itself.
  let ran = scriptDocker(["exec", "--user", SCRIPT_UID, "--workdir", runDir,
    "-e", "HOME=/workspace", "-e", "PATH=/workspace/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    container,
    "timeout", "-k", SCRIPT_KILL_GRACE, `${scriptWallSeconds()}`, runtime, jobAt]);

  // The output caps are enforced here on the host: what the model reads back
  // is at most the prefix, whatever the script printed.
  let cap = scriptOutputMax();
  let sout = scriptCut(ran.stdout, cap);
  let serr = scriptCut(ran.stderr, cap);
  if (ran.status != 0) {
    return scriptDone(container, stage, runDir, jobAt,
      scriptRanFlat(false, sout, serr, scriptStopped(ran.status, runtime), recreated, ""));
  }
  if (sout.length != ran.stdout.length || serr.length != ran.stderr.length) {
    // Past the cap nothing is written (RUN-SCRIPT.md failure table): the run
    // is treated as failed with its prefix kept, so a script cannot buy an
    // unreadable reply and a reconcile with the same print loop.
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
    stopped: "", recreated: recreated, problem: landed.problem,
  };
  return scriptDone(container, stage, runDir, jobAt, out);
}

// What a non-zero exit means, in the model's terms. 124 is timeout's own
// verdict; 127 is "no such command", which in a fixed image means the
// language asked for is not in it.
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
  if (language == "python") { return "python3"; }
  if (language == "node") { return "node"; }
  if (language == "sh") { return "sh"; }
  return "";
}

function scriptExt(language: string): string {
  if (language == "python") { return "py"; }
  if (language == "node") { return "js"; }
  return "sh";
}

// The digits of a stamp and nothing else, for paths built from a caller's
// `now`: whatever arrives, what reaches a path is [0-9].
function scriptDigits(text: string): string {
  let out = "";
  let i: int = 0;
  while (i < text.length) {
    let c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) { out = out + text.charAt(i); }
    i = i + 1;
  }
  return out == "" ? "0" : out;
}

// The host-side fs, each try beside its calls for the lambda rule above.
// The skill rows and files this run stages. Local readers rather than the
// ones in tools.ts, which imports this file — the queries are two lines each,
// and a cycle costs more than the repetition.
function scriptSkillRows(db: Db, agentId: string): SkillRow[] {
  // A run without an agent has no skills to stage — and the guard is what
  // keeps a bare scriptRun off tables its caller never migrated.
  if (agentId == "") { let none: SkillRow[] = []; return none; }
  let where = "id IN (SELECT skill_id FROM agent_skills WHERE agent_id = " + placeholderAt(db, 1) + ")";
  let document = listWhere(db, skillsMapping(), where, [agentId]);
  if (document == "" || document == "[]") { let none: SkillRow[] = []; return none; }
  return JSON.parse<SkillRow[]>(document);
}

function scriptSkillFiles(db: Db, skillId: string): SkillFileRow[] {
  let document = listWhere(db, skillFilesMapping(), "skill_id = " + placeholderAt(db, 1), [skillId]);
  if (document == "" || document == "[]") { let none: SkillFileRow[] = []; return none; }
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

function scriptHostDrop(dir: string): void {
  try {
    if (fs.existsSync(dir)) { fs.rmSync(dir, true); }
  } catch (e) {
    return;
  }
}
