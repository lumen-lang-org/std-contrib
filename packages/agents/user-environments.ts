// Environments a person defines: an image to run in, or a Dockerfile to build
// one from, plus — through env-keys.ts, scoped to the row's id — the secrets
// their scripts find there.
//
// script_images is the OPERATOR's catalog, and the invariant it enforces is
// about the model: nothing on the model's side of the wire may name an image,
// or a sentence in a retrieved document could make this server pull anything
// off the internet and run it. That invariant survives here untouched — this
// table is written from settings by a signed-in person, read at run time by
// the runner, and the model still only ever says a NAME.
//
// Two decisions carry the design:
//
//   Created means working. A create only returns once the image is pulled or
//   the Dockerfile is built, and a failure refuses the row with the build's
//   own last lines. There is no "pending" to poll and no environment that
//   exists but cannot start — the property the curated catalog never had,
//   where five enabled rows pointed at images no daemon held.
//
//   A build gets no context. The Dockerfile is staged alone in an empty
//   directory, so COPY and ADD have nothing to reach: what a build can do is
//   FROM, RUN, ENV — fetch from the network like any installer — and never
//   read a file off this host.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, createTableSql, deleteById, field, findById, listOrdered, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { envDockerBin } from "./environments.ts";

// run-script.ts's fold, copied rather than imported: the runner imports THIS
// module to resolve a name, so importing the runner back is the cycle the
// compiler refuses — and the fold must stay identical on both sides, or a
// name a person typed stops matching the name a model says.
function foldName(n: string): string {
  return n.toLowerCase().replaceAll("-", "").replaceAll("_", "").replaceAll(" ", "").replaceAll("+", "");
}

export const MAX_USER_ENVS_PER_OWNER: int = 10;
// The operator's overrides, deployment-wide, 0 meaning "the default". The
// per-owner cap was the only limit, and the red-team showed why it is not
// enough on its own: it resets per identity, so a deployment-wide ceiling is
// the number that actually bounds disk. 0 there means "no global ceiling",
// which is the behaviour before this setting existed.
let uenvPerOwnerChosen: int = 0;
let uenvGlobalChosen: int = 0;
export function uenvLimitsOverride(perOwner: int, global: int): void {
  uenvPerOwnerChosen = perOwner;
  uenvGlobalChosen = global;
}
function uenvPerOwner(): int { return uenvPerOwnerChosen > 0 ? uenvPerOwnerChosen : MAX_USER_ENVS_PER_OWNER; }
export function uenvGlobalCeiling(): int { return uenvGlobalChosen; }

// Every user environment on the deployment, across owners — what the global
// ceiling is measured against. The per-owner list cannot see this, which is
// the whole point: one owner within their cap, times many owners, is the
// exhaustion the ceiling exists to stop.
export function userEnvCountAll(db: Db): int {
  if (!db.query("SELECT count(*) FROM user_environments", [])) { return 0; }
  if (db.rows() == 0) { return 0; }
  // Parsed by hand rather than with parseInt, which answers i32|null here and
  // is the codebase's own habit for reading a number off the database. A
  // count is small and clean, so the loop stops at the first non-digit.
  let s = db.value(0, 0);
  let n: int = 0;
  let i: int = 0;
  while (i < s.length) {
    let c = s.charCodeAt(i);
    if (c < 48 || c > 57) { return n; }
    n = n * 10 + (c - 48);
    i = i + 1;
  }
  return n;
}
export const MAX_USER_ENV_NAME: int = 40;
// A Dockerfile longer than this is a repository, not a description of an
// environment.
export const MAX_DOCKERFILE: int = 16384;

export type UserEnvRow = {
  id: string,
  // Whose it is. Every read and every write is scoped by this.
  owner: string,
  // What scripts name it by — the same rule as a curated label, because it
  // enters the same resolution.
  name: string,
  // The reference docker runs: what was given, or the tag the build made.
  image: string,
  // "image" (pulled as given) or "dockerfile" (built here).
  source: string,
  // The Dockerfile that built `image`, kept verbatim: it is the row's own
  // documentation, and editing-by-recreate needs the previous text to start
  // from.
  dockerfile: string,
  createdAt: string,
};

export function userEnvsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("name", "name", "text"),
    field("image", "image", "text"),
    field("source", "source", "text"),
    field("dockerfile", "dockerfile", "text"),
    field("createdAt", "created_at", "text"),
  ];
  return repository("user_environments", "id", "id", fs);
}

export function userEnvsPlan(db: Db): Migration[] {
  // 111: env-keys.ts owns 110.
  return [
    migration("111", "user environments: an image or a Dockerfile, per person",
      createTableSql(db, userEnvsMapping())),
  ];
}

export function emptyUserEnv(): UserEnvRow {
  let none: UserEnvRow = {
    id: "", owner: "", name: "", image: "", source: "", dockerfile: "", createdAt: "",
  };
  return none;
}

// The docker seam, environments.ts's shape: an argument vector through
// spawnSync, never a shell string, and a failure is an answer.
let uenvChosenDocker: string = "";
export function uenvDockerOverride(bin: string): void { uenvChosenDocker = bin; }
function uenvDockerBin(): string {
  if (uenvChosenDocker != "") { return uenvChosenDocker; }
  return envDockerBin();
}
type UenvDockerReply = {
  status: int,
  stdout: string,
  stderr: string,
};
function uenvDocker(args: string[]): UenvDockerReply {
  let res = child_process.spawnSync(uenvDockerBin(), args);
  let reply: UenvDockerReply = { status: res.status, stdout: res.stdout, stderr: res.stderr };
  return reply;
}

// The last lines of a failed build or pull — what the person needs to fix
// their Dockerfile, cut to fit in a refusal.
function uenvTail(text: string): string {
  let lines = text.split("\n");
  let keep: string[] = [];
  let i: int = lines.length - 1;
  while (i >= 0 && keep.length < 6) {
    if (lines[i].trim() != "") { keep.unshift(lines[i].trim()); }
    i = i - 1;
  }
  let out = keep.join("\n");
  if (out.length > 700) { out = out.slice(out.length - 700); }
  return out;
}

// The tag a build produces. Deterministic from the row, prefixed so every
// image this module owns is findable by eye in `docker images` — and
// re-creating an environment of the same name overwrites the old tag rather
// than leaking one image per attempt.
export function uenvTag(id: string): string {
  return "agents-uenv-" + id;
}

/** This owner's environments, named order. */
export function userEnvsOf(db: Db, owner: string): UserEnvRow[] {
  let keys: DbOrder[] = [asc("name")];
  let listed = listOrdered(db, userEnvsMapping(), "owner = " + placeholderAt(db, 1), [owner], keys);
  if (listed == "" || listed == "[]") {
    let none: UserEnvRow[] = [];
    return none;
  }
  return JSON.parse<UserEnvRow[]>(listed);
}

/** One of this owner's, by id. Somebody else's is absent, not forbidden. */
export function userEnvById(db: Db, id: string, owner: string): UserEnvRow {
  let doc = findById(db, userEnvsMapping(), id);
  if (doc == "") { return emptyUserEnv(); }
  let row: UserEnvRow = JSON.parse<UserEnvRow>(doc);
  if (row.owner != owner) { return emptyUserEnv(); }
  return row;
}

/** This owner's environment answering to this name, folded the way every
 *  environment name is — "My Env" and "my-env" are one name. */
export function userEnvByName(db: Db, owner: string, name: string): UserEnvRow {
  let rows = userEnvsOf(db, owner);
  let i: int = 0;
  while (i < rows.length) {
    if (foldName(rows[i].name) == foldName(name)) { return rows[i]; }
    i = i + 1;
  }
  return emptyUserEnv();
}

export type UserEnvWrite = {
  owner: string,
  name: string,
  // Exactly one of these is given.
  image: string,
  dockerfile: string,
  now: string,
};

export type UserEnvMade = {
  id: string,
  problem: string,
};

/** Why this environment cannot be made, before docker is asked anything. */
export function refuseUserEnv(db: Db, ask: UserEnvWrite): string {
  if (ask.owner == "") { return "an environment has to belong to somebody"; }
  let name = ask.name.trim();
  if (name == "") { return "an environment needs a name — it is what run_script is asked for"; }
  if (name.length > MAX_USER_ENV_NAME) { return "\"" + name.slice(0, 20) + "...\" is too long a name"; }
  if (foldName(name) == "" || foldName(name) == "main" || foldName(name) == "default") {
    return "\"" + name + "\" is a name the runner already means something by — pick another";
  }
  let img = ask.image.trim();
  let df = ask.dockerfile.trim();
  if (img == "" && df == "") { return "an environment is an image or a Dockerfile — one of the two is required"; }
  if (img != "" && df != "") { return "an image or a Dockerfile, not both — the Dockerfile builds the image"; }
  if (df != "" && df.length > MAX_DOCKERFILE) {
    return "that Dockerfile is " + `${df.length}` + " characters — the most an environment takes is " + `${MAX_DOCKERFILE}`;
  }
  if (df != "" && df.toUpperCase().indexOf("FROM") < 0) {
    return "a Dockerfile starts FROM something";
  }
  if (userEnvByName(db, ask.owner, name).id != "") {
    return "you already have an environment called \"" + name + "\" — delete it first, or pick another name";
  }
  if (userEnvsOf(db, ask.owner).length >= uenvPerOwner()) {
    return "that is " + `${uenvPerOwner()}` + " environments already — delete one before adding another";
  }
  // The global ceiling, when the operator set one: the limit the per-owner cap
  // cannot express, because it is about the deployment's disk, not one person's
  // share of it.
  let ceiling = uenvGlobalCeiling();
  if (ceiling > 0 && userEnvCountAll(db) >= ceiling) {
    return "this deployment is at its limit of " + `${ceiling}` + " environments — an operator sets that, and clearing space is theirs to do";
  }
  return "";
}

/** Make an environment: refuse, then pull or build, then the row — so a row
 *  that exists is an environment that starts.
 *
 *  The build's staging directory holds the Dockerfile and nothing else, which
 *  is what keeps COPY and ADD inert. It is removed whatever happens; the
 *  image, on success, is the artifact. */
export function createUserEnv(db: Db, ask: UserEnvWrite): UserEnvMade {
  let wrong = refuseUserEnv(db, ask);
  if (wrong != "") { return { id: "", problem: wrong }; }
  let id = crypto.randomUUID();
  let name = ask.name.trim();
  let image = ask.image.trim();
  let source = "image";

  if (ask.dockerfile.trim() != "") {
    source = "dockerfile";
    image = uenvTag(id);
    let stage = "/tmp/agents-uenv-" + id;
    let staged = "";
    try {
      fs.mkdirSync(stage, true);
      fs.writeFileSync(stage + "/Dockerfile", ask.dockerfile);
    } catch (e) {
      staged = "the build could not be staged";
    }
    if (staged != "") { return { id: "", problem: staged }; }
    let built = uenvDocker(["build", "-t", image, stage]);
    try { fs.rmSync(stage, true); } catch (e) { /* the image is the artifact */ }
    if (built.status != 0) {
      return { id: "", problem: "the build failed:\n" + uenvTail(built.stderr == "" ? built.stdout : built.stderr) };
    }
  } else {
    // Pulled now rather than on first use, for the same reason the build is:
    // the failure belongs to the person configuring, not to a script three
    // days later. An image already on the daemon pulls as a no-op.
    let pulled = uenvDocker(["pull", image]);
    if (pulled.status != 0) {
      return { id: "", problem: "the image could not be pulled:\n" + uenvTail(pulled.stderr == "" ? pulled.stdout : pulled.stderr) };
    }
  }

  let row: UserEnvRow = {
    id: id, owner: ask.owner, name: name, image: image, source: source,
    dockerfile: ask.dockerfile.trim(), createdAt: ask.now,
  };
  let written = persist(db, userEnvsMapping(), JSON.stringify(row));
  if (!written.ok) { return { id: "", problem: written.error }; }
  return { id: id, problem: "" };
}

/** Forget an environment: the row, and — when this module built the image —
 *  the image too. A pulled image stays: it was never ours alone, and another
 *  environment or another person may name the same reference. Keys scoped to
 *  the row are the caller's to sweep, because env-keys.ts owns their
 *  envelopes and this module does not reach into it. */
export function forgetUserEnv(db: Db, id: string, owner: string): bool {
  let row = userEnvById(db, id, owner);
  if (row.id == "") { return false; }
  if (row.source == "dockerfile") {
    uenvDocker(["image", "rm", "-f", row.image]);
  }
  deleteById(db, userEnvsMapping(), row.id);
  return true;
}
