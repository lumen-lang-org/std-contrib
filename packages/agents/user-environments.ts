import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, createTableSql, deleteById, field, findById, listOrdered, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { envDockerBin } from "./environments.ts";

function foldName(n: string): string {
  return n.toLowerCase().replaceAll("-", "").replaceAll("_", "").replaceAll(" ", "").replaceAll("+", "");
}

export const MAX_USER_ENVS_PER_OWNER: int = 10;
let uenvPerOwnerChosen: int = 0;
let uenvGlobalChosen: int = 0;
export function uenvLimitsOverride(perOwner: int, global: int): void {
  uenvPerOwnerChosen = perOwner;
  uenvGlobalChosen = global;
}
function uenvPerOwner(): int {
  return uenvPerOwnerChosen > 0 ? uenvPerOwnerChosen : MAX_USER_ENVS_PER_OWNER;
}
export function uenvGlobalCeiling(): int {
  return uenvGlobalChosen;
}

export function userEnvCountAll(db: Db): int {
  if (!db.query("SELECT count(*) FROM user_environments", [])) {
    return 0;
  }
  if (db.rows() == 0) {
    return 0;
  }
  return parseInt(db.value(0, 0).trim(), 10) ?? 0;
}
export const MAX_USER_ENV_NAME: int = 40;
export const MAX_DOCKERFILE: int = 16384;

export type UserEnvRow = {
  id: string,
  owner: string,
  name: string,
  image: string,
  source: string,
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
  return repository({ table: "user_environments", idField: "id", idColumn: "id", fields: fs });
}

export function userEnvsPlan(db: Db): Migration[] {
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

let uenvChosenDocker: string = "";
export function uenvDockerOverride(bin: string): void {
  uenvChosenDocker = bin;
}
function uenvDockerBin(): string {
  if (uenvChosenDocker != "") {
    return uenvChosenDocker;
  }
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

function uenvTail(text: string): string {
  let lines = text.split("\n");
  let keep: string[] = [];
  let i: int = lines.length - 1;
  while (i >= 0 && keep.length < 6) {
    if (lines[i].trim() != "") {
      keep.unshift(lines[i].trim());
    }
    i = i - 1;
  }
  let out = keep.join("\n");
  if (out.length > 700) {
    out = out.slice(out.length - 700);
  }
  return out;
}

export function uenvTag(id: string): string {
  return "agents-uenv-" + id;
}

export function userEnvsOf(db: Db, owner: string): UserEnvRow[] {
  let keys: DbOrder[] = [{ column: "name" }];
  let listed = listOrdered(db, userEnvsMapping(), { where: "owner = " + placeholderAt(db, 1), args: [owner], order: keys });
  if (listed == "" || listed == "[]") {
    let none: UserEnvRow[] = [];
    return none;
  }
  return JSON.parse<UserEnvRow[]>(listed);
}

export function userEnvById(db: Db, id: string, owner: string): UserEnvRow {
  let doc = findById(db, userEnvsMapping(), id);
  if (doc == "") {
    return emptyUserEnv();
  }
  let row: UserEnvRow = JSON.parse<UserEnvRow>(doc);
  if (row.owner != owner) {
    return emptyUserEnv();
  }
  return row;
}

export function userEnvByName(db: Db, owner: string, name: string): UserEnvRow {
  let rows = userEnvsOf(db, owner);
  let i: int = 0;
  while (i < rows.length) {
    if (foldName(rows[i].name) == foldName(name)) {
      return rows[i];
    }
    i = i + 1;
  }
  return emptyUserEnv();
}

export type UserEnvWrite = {
  owner: string,
  name: string,
  image: string,
  dockerfile: string,
  now: string,
};

export type UserEnvMade = {
  id: string,
  problem: string,
};

export function refuseUserEnv(db: Db, ask: UserEnvWrite): string {
  if (ask.owner == "") {
    return "an environment has to belong to somebody";
  }
  let name = ask.name.trim();
  if (name == "") {
    return "an environment needs a name — it is what run_script is asked for";
  }
  if (name.length > MAX_USER_ENV_NAME) {
    return "\"" + name.slice(0, 20) + "...\" is too long a name";
  }
  if (foldName(name) == "" || foldName(name) == "main" || foldName(name) == "default") {
    return "\"" + name + "\" is a name the runner already means something by — pick another";
  }
  let img = ask.image.trim();
  let df = ask.dockerfile.trim();
  if (img == "" && df == "") {
    return "an environment is an image or a Dockerfile — one of the two is required";
  }
  if (img != "" && df != "") {
    return "an image or a Dockerfile, not both — the Dockerfile builds the image";
  }
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
  let ceiling = uenvGlobalCeiling();
  if (ceiling > 0 && userEnvCountAll(db) >= ceiling) {
    return "this deployment is at its limit of " + `${ceiling}` + " environments — an operator sets that, and clearing space is theirs to do";
  }
  return "";
}

export function createUserEnv(db: Db, ask: UserEnvWrite): UserEnvMade {
  let wrong = refuseUserEnv(db, ask);
  if (wrong != "") {
    return { id: "", problem: wrong };
  }
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
    if (staged != "") {
      return { id: "", problem: staged };
    }
    let built = uenvDocker(["build", "-t", image, stage]);
    try {
      fs.rmSync(stage, true);
    } catch (e) { }
    if (built.status != 0) {
      return { id: "", problem: "the build failed:\n" + uenvTail(built.stderr == "" ? built.stdout : built.stderr) };
    }
  } else {
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
  if (!written.ok) {
    return { id: "", problem: written.error };
  }
  return { id: id, problem: "" };
}

export function forgetUserEnv(db: Db, id: string, owner: string): bool {
  let row = userEnvById(db, id, owner);
  if (row.id == "") {
    return false;
  }
  if (row.source == "dockerfile") {
    uenvDocker(["image", "rm", "-f", row.image]);
  }
  deleteById(db, userEnvsMapping(), row.id);
  return true;
}
