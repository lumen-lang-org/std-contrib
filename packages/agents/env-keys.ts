import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, createTableSql, deleteById, field, findById, listOrdered, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { storeCredential, credentialFor, forgetCredential } from "./credentials.ts";

export const MAX_ENV_KEYS_PER_ENV: int = 20;
let envKeyPerEnvChosen: int = 0;
export function envKeyLimitOverride(perEnv: int): void {
  envKeyPerEnvChosen = perEnv;
}
function envKeyPerEnv(): int {
  return envKeyPerEnvChosen > 0 ? envKeyPerEnvChosen : MAX_ENV_KEYS_PER_ENV;
}
export const MAX_ENV_KEY_NAME: int = 64;
export const MAX_ENV_KEY_VALUE: int = 4096;

export type EnvKeyRow = {
  id: string,
  owner: string,
  imageId: string,
  name: string,
  createdAt: string,
  lastUsedAt: string,
};

export function envKeysMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("imageId", "image_id", "text"),
    field("name", "name", "text"),
    field("createdAt", "created_at", "text"),
    field("lastUsedAt", "last_used_at", "text"),
  ];
  return repository({ table: "env_keys", idField: "id", idColumn: "id", fields: fs });
}

export function envKeysPlan(db: Db): Migration[] {
  return [
    migration("110", "env keys: a variable a script runs with but never holds",
      createTableSql(db, envKeysMapping())),
  ];
}

export function emptyEnvKey(): EnvKeyRow {
  let none: EnvKeyRow = {
    id: "", owner: "", imageId: "", name: "", createdAt: "", lastUsedAt: "",
  };
  return none;
}

function refOf(id: string): string {
  return "envkey:" + id;
}

const RESERVED: string[] = [
  "PATH", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "LD_PRELOAD",
  "LD_LIBRARY_PATH", "LD_AUDIT", "NODE_OPTIONS", "PYTHONSTARTUP", "PYTHONPATH",
  "PERL5OPT", "RUBYOPT",
];

function reserved(name: string): bool {
  let i: int = 0;
  while (i < RESERVED.length) {
    if (RESERVED[i] == name) {
      return true;
    }
    i = i + 1;
  }
  return false;
}

function nameIsShaped(name: string): bool {
  if (name.length == 0) {
    return false;
  }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    let digit = c >= 48 && c <= 57;
    let under = c == 95;
    if (i == 0 && !(letter || under)) {
      return false;
    }
    if (i > 0 && !(letter || digit || under)) {
      return false;
    }
    i = i + 1;
  }
  return true;
}

export function refuseEnvKey(row: EnvKeyRow, value: string): string {
  if (row.owner == "") {
    return "an environment key has to belong to somebody";
  }
  if (row.imageId == "") {
    return "an environment key belongs to one environment — none was named";
  }
  let name = row.name.trim();
  if (name == "") {
    return "an environment key needs a name — it is what the script reads";
  }
  if (name.length > MAX_ENV_KEY_NAME) {
    return "\"" + name.slice(0, 20) + "...\" is too long a name for a variable";
  }
  if (!nameIsShaped(name)) {
    return "\"" + name + "\" is not a variable name — letters, digits and underscores, not starting with a digit, like OPENAI_API_KEY";
  }
  if (reserved(name.toUpperCase())) {
    return "\"" + name + "\" is read by the container before your script is, so setting it would change what runs rather than what it can reach — pick another name";
  }
  if (value.length > MAX_ENV_KEY_VALUE) {
    return "that value is " + `${value.length}` + " characters — the most a key may hold is " + `${MAX_ENV_KEY_VALUE}`;
  }
  if (value.indexOf("\n") >= 0 || value.indexOf("\r") >= 0) {
    return "a key's value cannot contain a line break — the container reads these one per line";
  }
  return "";
}

export function envKeysOf(db: Db, owner: string, imageId: string): string {
  let keys: DbOrder[] = [{ column: "name" }];
  return listOrdered(db, envKeysMapping(), {
    where: "owner = " + db.placeholder + " AND image_id = " + placeholderAt(db, 2),
    args: [owner, imageId],
    order: keys,
  });
}

export function envKeysOwnedBy(db: Db, owner: string): string {
  let keys: DbOrder[] = [{ column: "image_id" }, { column: "name" }];
  return listOrdered(db, envKeysMapping(), {
    where: "owner = " + db.placeholder,
    args: [owner],
    order: keys,
  });
}

export function envKeyById(db: Db, id: string, owner: string): EnvKeyRow {
  let doc = findById(db, envKeysMapping(), id);
  if (doc == "") {
    return emptyEnvKey();
  }
  let row: EnvKeyRow = JSON.parse<EnvKeyRow>(doc);
  if (row.owner != owner) {
    return emptyEnvKey();
  }
  return row;
}

export function envKeyByName(db: Db, name: string, owner: string, imageId: string): EnvKeyRow {
  let rows = JSON.parse<EnvKeyRow[]>(envKeysOf(db, owner, imageId));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].name == name.trim()) {
      return rows[i];
    }
    i = i + 1;
  }
  return emptyEnvKey();
}

export type EnvKeyWrite = {
  owner: string,
  imageId: string,
  name: string,
  value: string,
  master: string,
  now: string,
};

export type EnvKeyMade = {
  id: string,
  problem: string,
};

export function createEnvKey(db: Db, ask: EnvKeyWrite): EnvKeyMade {
  let row: EnvKeyRow = {
    id: crypto.randomUUID(),
    owner: ask.owner,
    imageId: ask.imageId,
    name: ask.name.trim(),
    createdAt: ask.now,
    lastUsedAt: "",
  };
  let wrong = refuseEnvKey(row, ask.value);
  if (wrong != "") {
    return { id: "", problem: wrong };
  }
  if (envKeyByName(db, row.name, row.owner, row.imageId).id != "") {
    return {
      id: "",
      problem: "there is already a key called \"" + row.name + "\" in this environment — delete it first, or pick another name",
    };
  }
  let held = JSON.parse<EnvKeyRow[]>(envKeysOf(db, row.owner, row.imageId));
  if (held.length >= envKeyPerEnv()) {
    return {
      id: "",
      problem: "that is " + `${envKeyPerEnv()}` + " keys in this environment already — delete one before adding another",
    };
  }
  let stored = storeCredential(db, {
    provider: refOf(row.id), apiKey: ask.value, masterKey: ask.master, now: ask.now,
  });
  if (stored != "") {
    return { id: "", problem: stored };
  }
  let written = persist(db, envKeysMapping(), JSON.stringify(row));
  if (!written.ok) {
    forgetCredential(db, refOf(row.id));
    return { id: "", problem: written.error };
  }
  return { id: row.id, problem: "" };
}

export function forgetEnvKey(db: Db, id: string, owner: string): bool {
  let row = envKeyById(db, id, owner);
  if (row.id == "") {
    return false;
  }
  forgetCredential(db, refOf(row.id));
  deleteById(db, envKeysMapping(), row.id);
  return true;
}

export function envKeyFileBody(db: Db, owner: string, imageId: string, master: string): string {
  let rows = JSON.parse<EnvKeyRow[]>(envKeysOf(db, owner, imageId));
  let out = "";
  let i: int = 0;
  while (i < rows.length) {
    let value = credentialFor(db, refOf(rows[i].id), master);
    if (value != "") {
      out = out + rows[i].name + "=" + value + "\n";
    }
    i = i + 1;
  }
  return out;
}

export function envKeyCount(db: Db, owner: string, imageId: string): int {
  let rows = JSON.parse<EnvKeyRow[]>(envKeysOf(db, owner, imageId));
  return rows.length;
}

export function envKeyNames(db: Db, owner: string, imageId: string): string[] {
  let rows = JSON.parse<EnvKeyRow[]>(envKeysOf(db, owner, imageId));
  let out: string[] = [];
  let i: int = 0;
  while (i < rows.length) {
    out.push(rows[i].name);
    i = i + 1;
  }
  return out;
}

export function touchEnvKeys(db: Db, owner: string, imageId: string, now: string): void {
  db.query("UPDATE env_keys SET last_used_at = " + db.placeholder
    + " WHERE owner = " + placeholderAt(db, 2) + " AND image_id = " + placeholderAt(db, 3),
    [now, owner, imageId]);
}
