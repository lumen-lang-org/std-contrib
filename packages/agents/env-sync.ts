import { Db } from "../plume/driver.ts";
import { EnvRow, envBySlug, envContainerName, envDockerBin, envMarkSynced } from "./environments.ts";
import { ArtifactWrite, TURN_SEQ_NONE, binaryKind, getVersion, kindOf, listArtifacts, putArtifact } from "./artifacts.ts";

// The container is a cache; the artifacts are the record.
//
// That is already the rule for run_script, and a serving environment quietly
// broke it: a dev server's project lived in a docker volume and nowhere else,
// so losing the volume lost the work. This file is what makes the rule true
// again — the workspace is written from artifacts when an environment starts,
// and what changes inside it comes back as new versions.
//
// What is NOT a record: anything a machine can regenerate. node_modules is
// thirty thousand files and one `npm ci` away; a build directory is output.
// Storing those would exhaust the per-thread cap on the first install and would
// tell nobody anything they could not rebuild.

export const ENV_WORKSPACE: string = "/workspace";

/** Directories whose contents are regenerable, and the files a dev server
 *  rewrites constantly. Pruned in the container rather than filtered after, so
 *  their bytes never cross the wire. */
const ENV_SYNC_SKIP: string[] = [
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", ".vite", ".cache",
  ".turbo", ".parcel-cache", "dist", "build", "out", "coverage", "target",
  "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", "tmp",
];

/** Names that are noise whatever directory they sit in. */
const ENV_SYNC_SKIP_FILE: string[] = [
  ".DS_Store", "npm-debug.log", "yarn-error.log", ".env.local",
];

export function envSyncSkips(): string[] {
  return ENV_SYNC_SKIP;
}

/** Whether a path under the workspace is one this sync ignores. Written apart
 *  from the finding so the rule can be read and tested on its own. */
export function envSyncIgnored(path: string): bool {
  let rest = path.startsWith("./") ? path.slice(2) : path;
  if (rest == "") {
    return true;
  }
  let parts = rest.split("/");
  let i: int = 0;
  while (i < parts.length) {
    let part = parts[i];
    if (part == "") {
      i = i + 1;
      continue;
    }
    let d: int = 0;
    while (d < ENV_SYNC_SKIP.length) {
      // A directory name anywhere in the path, not only at the root: a
      // monorepo has one node_modules per package.
      if (part == ENV_SYNC_SKIP[d]) {
        return true;
      }
      d = d + 1;
    }
    if (part.endsWith(".log")) {
      return true;
    }
    let f: int = 0;
    while (f < ENV_SYNC_SKIP_FILE.length) {
      if (part == ENV_SYNC_SKIP_FILE[f]) {
        return true;
      }
      f = f + 1;
    }
    i = i + 1;
  }
  return false;
}

/** The project's own ignore rules, read from the container.
 *
 *  A hand-written list of directory names is a guess; a .gitignore is the
 *  answer the project already gives, kept by whoever wrote it and correct for
 *  that project rather than for projects in general. The built-in list stays as
 *  the floor, because a workspace with no .gitignore still must not carry
 *  node_modules back.
 *
 *  Read as literal path fragments, not as full gitignore syntax: this decides
 *  what is worth storing, and treating a pattern too broadly loses somebody's
 *  file. Negations are ignored for the same reason — a rule this cannot read is
 *  a rule it does not act on. */
export function envSyncRulesFrom(text: string): string[] {
  let out: string[] = [];
  let lines = text.split("\n");
  let i: int = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    i = i + 1;
    if (line == "" || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    // A trailing slash means a directory, which is what this already matches
    // on; a leading one anchors to the root, which this does not distinguish.
    let rule = line;
    while (rule.endsWith("/")) {
      rule = rule.slice(0, rule.length - 1);
    }
    while (rule.startsWith("/")) {
      rule = rule.slice(1);
    }
    // A pattern with a wildcard in the middle of a path is beyond what this
    // reads, and guessing at it is how a file nobody meant to drop is dropped.
    if (rule == "" || rule.indexOf("/") >= 0) {
      continue;
    }
    out.push(rule);
  }
  return out;
}

/** Whether a path is ignored, given the project's own rules on top of the
 *  built-in floor. A rule ending in a suffix pattern (*.log) matches by
 *  suffix; anything else matches a whole path segment. */
export function envSyncIgnoredBy(path: string, rules: string[]): bool {
  if (envSyncIgnored(path)) {
    return true;
  }
  let rest = path.startsWith("./") ? path.slice(2) : path;
  let parts = rest.split("/");
  let i: int = 0;
  while (i < parts.length) {
    let part = parts[i];
    i = i + 1;
    if (part == "") {
      continue;
    }
    let r: int = 0;
    while (r < rules.length) {
      let rule = rules[r];
      r = r + 1;
      if (rule.startsWith("*") && rule.length > 1) {
        if (part.endsWith(rule.slice(1))) {
          return true;
        }
      } else if (part == rule) {
        return true;
      }
    }
  }
  return false;
}

/** The `find` that lists what changed, with the skipped directories pruned
 *  before it descends into them. Pure, because getting a prune expression
 *  slightly wrong is how a sync quietly reads a hundred thousand files. */
export function envSyncFindCmd(sinceEpochSeconds: string): string {
  let prune = "";
  let i: int = 0;
  while (i < ENV_SYNC_SKIP.length) {
    prune = prune + (prune == "" ? "" : " -o ") + "-name '" + ENV_SYNC_SKIP[i] + "'";
    i = i + 1;
  }
  let newer = sinceEpochSeconds == "" || sinceEpochSeconds == "0"
    ? ""
    : " -newermt '@" + sinceEpochSeconds + "'";
  return "cd " + ENV_WORKSPACE
    + " && find . \\( " + prune + " \\) -prune -o -type f" + newer + " -print";
}

type EnvSyncReply = {
  status: int,
  stdout: string,
  stderr: string,
};

function envSyncDocker(args: string[]): EnvSyncReply {
  let res = child_process.spawnSync(envDockerBin(), args);
  let out: EnvSyncReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return out;
}

/** The container's clock, in epoch seconds.
 *
 *  Its clock and not this process's: `-newermt` compares against file times
 *  over there, and these are two machines a tailnet apart. An engine running a
 *  second fast silently skips edits; a second slow re-reads the same files for
 *  ever. */
export function envSyncClock(row: EnvRow): string {
  let asked = envSyncDocker(["exec", envContainerName(row.threadId, row.name), "date", "+%s"]);
  if (asked.status != 0) {
    return "";
  }
  let said = asked.stdout.trim();
  let i: int = 0;
  while (i < said.length) {
    let c = said.charCodeAt(i);
    if (c < 48 || c > 57) {
      return "";
    }
    i = i + 1;
  }
  return said;
}

export type EnvSynced = {
  ok: bool,
  changed: string[],
  skipped: int,
  fault: string,
};

/** Files the container has written since a stamp, brought back as artifact
 *  versions. Only the changed ones are read: a workspace is large and almost
 *  none of it moves between one sweep and the next. */
export function envSyncOut(db: Db, row: EnvRow, sinceEpochSeconds: string, now: string): EnvSynced {
  let none: string[] = [];
  let container = envContainerName(row.threadId, row.name);
  let found = envSyncDocker(["exec", container, "sh", "-c", envSyncFindCmd(sinceEpochSeconds)]);
  if (found.status != 0) {
    let bad: EnvSynced = { ok: false, changed: none, skipped: 0, fault: "the workspace could not be read" };
    return bad;
  }
  let ignore = envSyncDocker(["exec", container, "sh", "-c",
    "cat " + ENV_WORKSPACE + "/.gitignore 2>/dev/null || true"]);
  let rules = ignore.status == 0 ? envSyncRulesFrom(ignore.stdout) : envSyncRulesFrom("");
  let lines = found.stdout.split("\n");
  let changed: string[] = [];
  let skipped: int = 0;
  let i: int = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    i = i + 1;
    if (line == "" || envSyncIgnoredBy(line, rules)) {
      continue;
    }
    let at = line.startsWith("./") ? line.slice(1) : line;
    // Text is read as text and a picture as base64, which is the same
    // distinction the artifact store draws. Reading everything as base64 would
    // mean decoding here, and this runtime's spawn has no stdin to decode with.
    let binary = binaryKind(kindOf(at));
    let read = binary
      ? envSyncDocker(["exec", container, "base64", "-w0", ENV_WORKSPACE + at])
      : envSyncDocker(["exec", container, "cat", ENV_WORKSPACE + at]);
    if (read.status != 0) {
      skipped = skipped + 1;
      continue;
    }
    let body = binary ? read.stdout.trim() : read.stdout;
    let write: ArtifactWrite = {
      threadId: row.threadId,
      path: at,
      title: "",
      content: body,
      note: "written in " + row.name,
      origin: "generated",
      mustCreate: false,
      turnSeq: TURN_SEQ_NONE,
      now: now,
    };
    let put = putArtifact(db, write);
    if (put.ok) {
      changed.push(at);
    } else {
      // Named, not counted. A refusal that only increments a number is a
      // refusal nobody reads: this one said "origin must be uploaded or
      // generated" for four cycles while the sweep reported nothing at all.
      console.error("workspace refused " + at + ": " + put.fault);
      skipped = skipped + 1;
    }
  }
  let done: EnvSynced = { ok: true, changed: changed, skipped: skipped, fault: "" };
  return done;
}

/** A fresh container filled from the conversation it belongs to, and stamped so
 *  the next sweep only looks at what changed afterwards.
 *
 *  One function because there are two callers and they must not drift: a
 *  container made by the serve route and a container made for a fork are the
 *  same empty box, and the fork's was left empty for exactly as long as this
 *  lived only in the serve route — `npm run dev` in a directory with nothing in
 *  it, reported as a panel that would not load. */
export function envMaterialise(db: Db, slug: string, stageDir: string): EnvSynced {
  let row = envBySlug(db, slug);
  if (row.id == "") {
    let none: string[] = [];
    let gone: EnvSynced = { ok: false, changed: none, skipped: 0,
      fault: "no environment has that address" };
    return gone;
  }
  let put = envSyncIn(db, row, stageDir);
  if (put.ok) {
    envMarkSynced(db, row, envSyncClock(row));
  }
  return put;
}

/** The artifacts of a conversation, written into its workspace.
 *
 *  Run before the serve command, so a container made from scratch comes up
 *  holding the same project the conversation holds. */
export function envSyncIn(db: Db, row: EnvRow, stageDir: string): EnvSynced {
  let none: string[] = [];
  let container = envContainerName(row.threadId, row.name);
  let listed = listArtifacts(db, row.threadId);
  let wrote: string[] = [];
  let skipped: int = 0;
  let i: int = 0;
  while (i < listed.length) {
    let one = listed[i];
    i = i + 1;
    if (envSyncIgnored(one.path)) {
      skipped = skipped + 1;
      continue;
    }
    let held = getVersion(db, one.id, one.currentVersion);
    if (held.id == "") {
      skipped = skipped + 1;
      continue;
    }
    let full = stageDir + one.path;
    let cut = full.lastIndexOf("/");
    if (cut > 0) {
      fs.mkdirSync(full.slice(0, cut), true);
    }
    // A picture is stored base64 and must go back as bytes. Written as the text
    // it is stored in, a 13KB PNG lands as 17KB of ASCII — a file of exactly
    // the right name that no browser will draw, which is how the fork of a
    // React app came up with a broken image where its logo should be.
    let body = binaryKind(one.kind) ? crypto.base64Decode(held.body) : held.body;
    fs.writeFileSync(full, body);
    wrote.push(one.path);
  }
  if (wrote.length == 0) {
    let empty: EnvSynced = { ok: true, changed: none, skipped: skipped, fault: "" };
    return empty;
  }
  let placed = envSyncDocker(["cp", stageDir + "/.", container + ":" + ENV_WORKSPACE]);
  if (placed.status != 0) {
    let bad: EnvSynced = {
      ok: false, changed: none, skipped: skipped,
      fault: "the workspace could not be written",
    };
    return bad;
  }
  let done: EnvSynced = { ok: true, changed: wrote, skipped: skipped, fault: "" };
  return done;
}
