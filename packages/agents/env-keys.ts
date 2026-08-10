// The environment variables a person's scripts run with, without the platform
// ever holding one in the clear.
//
// A script that calls a real API needs a key, and until now there was nowhere
// to put one: envRunArgs emits no -e at all, so the only way to give a script
// a token was to type it into the script — which is a message in a
// conversation, stored, replayed to the model on the next turn, and shown to
// anybody the conversation is shared with.
//
// The shape is secrets.ts's, for secrets.ts's reasons: the row here, the value
// through credentials.ts under ref "envkey:<id>", write-only forever, and the
// two written together or not at all. What differs is the scope. A secret
// belongs to an owner and names one destination; an environment key belongs to
// an owner AND one curated image, because "my key for the office environment"
// and "my key for the browser environment" are different keys that a person
// should be able to set separately without either leaking into the other.
//
// How the value reaches the container matters as much as how it is stored. It
// is NEVER an argument: `docker exec -e NAME=value` puts the value in the
// process table of the host running the daemon, where every other tenant of
// that box can read it out of `ps`. envKeyFileBody writes the docker CLI's
// --env-file format instead, the file is 0600 in the run's own staging
// directory, the CLI reads it on THIS side of the ssh transport, and the file
// is deleted with the rest of the stage. The value crosses the wire inside the
// daemon's API call and appears in no argv on either machine.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, createTableSql, deleteById, field, findById, listOrdered, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";
import { storeCredential, credentialFor, forgetCredential } from "./credentials.ts";

// Bounded like every other per-owner thing, at a number nobody real reaches:
// twenty keys in one environment is a deployment's worth of integrations, not
// a person's.
export const MAX_ENV_KEYS_PER_ENV: int = 20;
// The operator's override, deployment-wide, 0 meaning "the default above".
let envKeyPerEnvChosen: int = 0;
export function envKeyLimitOverride(perEnv: int): void { envKeyPerEnvChosen = perEnv; }
function envKeyPerEnv(): int { return envKeyPerEnvChosen > 0 ? envKeyPerEnvChosen : MAX_ENV_KEYS_PER_ENV; }
export const MAX_ENV_KEY_NAME: int = 64;
// The same ceiling secrets use. A value longer than this is a file, and a file
// belongs in the workspace, not in the process environment.
export const MAX_ENV_KEY_VALUE: int = 4096;

export type EnvKeyRow = {
  id: string,
  // Whose it is. Every read and every write is scoped by this.
  owner: string,
  // Which curated environment it applies to: a script_images row id. Keys are
  // per environment so that granting a script the browser image does not hand
  // it the key somebody stored for the office one.
  imageId: string,
  // The variable's name, as the script will read it: OPENAI_API_KEY.
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
  return repository("env_keys", "id", "id", fs);
}

export function envKeysPlan(db: Db): Migration[] {
  // 110: secrets.ts owns 109, and a migration that sorts below one already
  // applied refuses the whole plan.
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

// Where the value lives in the credential store. Spelled once, so that no
// caller can orphan an envelope by spelling it differently.
function refOf(id: string): string {
  return "envkey:" + id;
}

// The names a person may not take, because the container reads them before it
// reads the script. PATH and SHELL choose which binary runs; LD_PRELOAD and
// LD_LIBRARY_PATH choose which library every binary loads; BASH_ENV and ENV
// are read by a shell at startup; NODE_OPTIONS and PYTHONSTARTUP each name a
// file the runtime executes before the program. Any of them turns "configure
// my environment" into "run my code with the platform's hands", which is a
// different permission from the one this feature grants.
//
// IFS is here because a shell's field splitting is how a quoted-looking
// command becomes several.
const RESERVED: string[] = [
  "PATH", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "LD_PRELOAD",
  "LD_LIBRARY_PATH", "LD_AUDIT", "NODE_OPTIONS", "PYTHONSTARTUP", "PYTHONPATH",
  "PERL5OPT", "RUBYOPT",
];

function reserved(name: string): bool {
  let i: int = 0;
  while (i < RESERVED.length) {
    if (RESERVED[i] == name) { return true; }
    i = i + 1;
  }
  return false;
}

// POSIX says a name is a letter or underscore followed by letters, digits and
// underscores. Walked by hand rather than matched, the way environments.ts
// sanitises a container name and for the same reason: this decides what a
// process environment will contain, and it should be readable as exactly the
// set it admits.
function nameIsShaped(name: string): bool {
  if (name.length == 0) { return false; }
  let i: int = 0;
  while (i < name.length) {
    let c = name.charCodeAt(i);
    let letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    let digit = c >= 48 && c <= 57;
    let under = c == 95;
    if (i == 0 && !(letter || under)) { return false; }
    if (i > 0 && !(letter || digit || under)) { return false; }
    i = i + 1;
  }
  return true;
}

/** Why this key cannot be stored, or "". The VALUE's own rules live in
 *  credentials.ts (an empty key is not a credential; the master key must be
 *  usable) — this adds what the row and the file format know. */
export function refuseEnvKey(row: EnvKeyRow, value: string): string {
  if (row.owner == "") { return "an environment key has to belong to somebody"; }
  if (row.imageId == "") { return "an environment key belongs to one environment — none was named"; }
  let name = row.name.trim();
  if (name == "") { return "an environment key needs a name — it is what the script reads"; }
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
  // --env-file is line-based: a newline in a value does not escape, it starts
  // a second variable. Refused rather than stripped, because silently storing
  // something other than what was typed is how a key becomes mysteriously
  // wrong three weeks later.
  if (value.indexOf("\n") >= 0 || value.indexOf("\r") >= 0) {
    return "a key's value cannot contain a line break — the container reads these one per line";
  }
  return "";
}

/** This owner's keys for this environment, named, never valued. */
export function envKeysOf(db: Db, owner: string, imageId: string): string {
  let keys: DbOrder[] = [asc("name")];
  return listOrdered(db, envKeysMapping(),
    "owner = " + db.placeholder + " AND image_id = " + placeholderAt(db, 2),
    [owner, imageId], keys);
}

/** Every key this owner has, across environments — what the settings screen
 *  lists, grouped by image on the way out. */
export function envKeysOwnedBy(db: Db, owner: string): string {
  let keys: DbOrder[] = [asc("image_id"), asc("name")];
  return listOrdered(db, envKeysMapping(), "owner = " + db.placeholder, [owner], keys);
}

/** One key, if it is this owner's. Somebody else's is absent, not forbidden —
 *  the rule secrets.ts states and this holds to. */
export function envKeyById(db: Db, id: string, owner: string): EnvKeyRow {
  let doc = findById(db, envKeysMapping(), id);
  if (doc == "") { return emptyEnvKey(); }
  let row: EnvKeyRow = JSON.parse<EnvKeyRow>(doc);
  if (row.owner != owner) { return emptyEnvKey(); }
  return row;
}

/** This owner's key of this name in this environment, or empty. A process
 *  environment cannot hold two variables of one name, so neither may the
 *  table — checked here, where the lookup is. */
export function envKeyByName(db: Db, name: string, owner: string, imageId: string): EnvKeyRow {
  let rows = JSON.parse<EnvKeyRow[]>(envKeysOf(db, owner, imageId));
  let i: int = 0;
  while (i < rows.length) {
    if (rows[i].name == name.trim()) { return rows[i]; }
    i = i + 1;
  }
  return emptyEnvKey();
}

export type EnvKeyWrite = {
  owner: string,
  imageId: string,
  name: string,
  // Stored encrypted, never read back by any route.
  value: string,
  master: string,
  now: string,
};

export type EnvKeyMade = {
  id: string,
  problem: string,
};

/** Store a key: the row and the value together, or neither.
 *
 *  The value goes through credentials.ts and is refused there for
 *  credentials.ts's reasons; the row is written only once the value is
 *  encrypted, so there is never a named key that opens to nothing. */
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
  if (wrong != "") { return { id: "", problem: wrong }; }
  if (envKeyByName(db, row.name, row.owner, row.imageId).id != "") {
    return { id: "", problem: "there is already a key called \"" + row.name + "\" in this environment — delete it first, or pick another name" };
  }
  let held = JSON.parse<EnvKeyRow[]>(envKeysOf(db, row.owner, row.imageId));
  if (held.length >= envKeyPerEnv()) {
    return { id: "", problem: "that is " + `${envKeyPerEnv()}` + " keys in this environment already — delete one before adding another" };
  }
  let stored = storeCredential(db, {
    provider: refOf(row.id), apiKey: ask.value, masterKey: ask.master, now: ask.now,
  });
  if (stored != "") { return { id: "", problem: stored }; }
  let written = persist(db, envKeysMapping(), JSON.stringify(row));
  if (!written.ok) {
    // The row failed after the envelope was written; take the envelope back,
    // or the credential store keeps a value nothing will ever name again.
    forgetCredential(db, refOf(row.id));
    return { id: "", problem: written.error };
  }
  return { id: row.id, problem: "" };
}

/** Forget a key: the value and the row, in that order. The envelope first,
 *  because a row without a value reads as "configured and broken", which is
 *  fixable by deleting it again — while a value without a row is unreachable
 *  and invisible. */
export function forgetEnvKey(db: Db, id: string, owner: string): bool {
  let row = envKeyById(db, id, owner);
  // False rather than a message, matching forgetSecret: somebody else's key is
  // absent, not forbidden, and the route turns that into a 404 without ever
  // confirming that the id names something.
  if (row.id == "") { return false; }
  forgetCredential(db, refOf(row.id));
  deleteById(db, envKeysMapping(), row.id);
  return true;
}

/** The docker --env-file body for this owner's keys in this environment.
 *
 *  "" when there are none, which the caller must treat as "pass no
 *  --env-file at all" — docker refuses an empty file path, and a run with no
 *  keys should not be a different code path from a run with them.
 *
 *  A key whose envelope will not open is SKIPPED, not guessed at: that is a
 *  wrong master key or an altered row, and the honest failure is the script
 *  finding the variable absent rather than finding it empty and treating the
 *  empty string as a token. Callers get the count so they can say so. */
export function envKeyFileBody(db: Db, owner: string, imageId: string, master: string): string {
  let rows = JSON.parse<EnvKeyRow[]>(envKeysOf(db, owner, imageId));
  let out = "";
  let i: int = 0;
  while (i < rows.length) {
    let value = credentialFor(db, refOf(rows[i].id), master);
    if (value != "") { out = out + rows[i].name + "=" + value + "\n"; }
    i = i + 1;
  }
  return out;
}

/** How many of this owner's keys in this environment will actually arrive.
 *  Counted separately from the body so a caller can tell a script's author
 *  "three keys" without holding three values to count them. */
export function envKeyCount(db: Db, owner: string, imageId: string): int {
  let rows = JSON.parse<EnvKeyRow[]>(envKeysOf(db, owner, imageId));
  return rows.length;
}

/** The names alone, for the model's briefing. The model is told WHICH
 *  variables its scripts will find — that is what makes them usable — and
 *  never a value, which is what keeps them secret. */
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

/** Stamp a use, so a person can see which keys are alive and which are
 *  candidates to delete. Best-effort: a run must not fail over a stamp. */
export function touchEnvKeys(db: Db, owner: string, imageId: string, now: string): void {
  db.query("UPDATE env_keys SET last_used_at = " + db.placeholder
    + " WHERE owner = " + placeholderAt(db, 2) + " AND image_id = " + placeholderAt(db, 3),
    [now, owner, imageId]);
}
