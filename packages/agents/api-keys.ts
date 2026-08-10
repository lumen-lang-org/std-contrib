import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, createTableSql, deleteById, field, findById, listOrdered, listWhere, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

export const MAX_KEYS_PER_OWNER: int = 20;
export const MAX_KEY_NAME: int = 60;

export const JOULE_SCOPES: string[] = ["search", "retrieve", "suggest"];

export type ApiKeyRow = {
  id: string,
  owner: string,
  name: string,
  keyPrefix: string,
  keyHash: string,
  scopes: string,
  createdAt: string,
  lastUsedAt: string,
};

export function apiKeysMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("owner", "owner", "text"),
    field("name", "name", "text"),
    field("keyPrefix", "key_prefix", "text"),
    field("keyHash", "key_hash", "text"),
    field("scopes", "scopes", "text"),
    field("createdAt", "created_at", "text"),
    field("lastUsedAt", "last_used_at", "text"),
  ];
  return repository("api_keys", "id", "id", fs);
}

export function apiKeysPlan(db: Db): Migration[] {
  return [
    migration("115", "api keys: a standing credential for the public /v1 products",
      createTableSql(db, apiKeysMapping())),
  ];
}

export function emptyApiKey(): ApiKeyRow {
  let none: ApiKeyRow = {
    id: "", owner: "", name: "", keyPrefix: "", keyHash: "", scopes: "",
    createdAt: "", lastUsedAt: "",
  };
  return none;
}

export type ApiKeyView = {
  id: string,
  name: string,
  keyPrefix: string,
  scopes: string,
  createdAt: string,
  lastUsedAt: string,
};

function viewOf(row: ApiKeyRow): ApiKeyView {
  let v: ApiKeyView = {
    id: row.id, name: row.name, keyPrefix: row.keyPrefix, scopes: row.scopes,
    createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
  };
  return v;
}

function isJouleScope(s: string): bool {
  let i: int = 0;
  while (i < JOULE_SCOPES.length) {
    if (JOULE_SCOPES[i] == s) { return true; }
    i = i + 1;
  }
  return false;
}

export function cleanScopes(raw: string): string {
  let parts = raw.split(",");
  let out = "";
  let i: int = 0;
  while (i < parts.length) {
    let t = parts[i].trim().toLowerCase();
    if (t == "*") { return "*"; }
    if (t != "" && isJouleScope(t)) {
      out = out == "" ? t : out + "," + t;
    }
    i = i + 1;
  }
  return out;
}

export function scopeList(scopes: string): string[] {
  if (scopes.trim() == "*") {
    let all: string[] = ["*"];
    return all;
  }
  let parts = scopes.split(",");
  let out: string[] = [];
  let i: int = 0;
  while (i < parts.length) {
    let t = parts[i].trim();
    if (t != "") { out.push(t); }
    i = i + 1;
  }
  return out;
}

export function hasScope(granted: string[], required: string): bool {
  let i: int = 0;
  while (i < granted.length) {
    if (granted[i] == "*") { return true; }
    if (granted[i] == required) { return true; }
    i = i + 1;
  }
  return false;
}

export function apiKeysOf(db: Db, owner: string): string {
  let keys: DbOrder[] = [asc("created_at")];
  let listed = listOrdered(db, apiKeysMapping(), "owner = " + db.placeholder, [owner], keys);
  if (listed == "" || listed == "[]") { return "[]"; }
  let rows = JSON.parse<ApiKeyRow[]>(listed);
  let views: ApiKeyView[] = [];
  let i: int = 0;
  while (i < rows.length) { views.push(viewOf(rows[i])); i = i + 1; }
  return JSON.stringify(views);
}

function keysOwnedCount(db: Db, owner: string): int {
  let listed = listOrdered(db, apiKeysMapping(), "owner = " + db.placeholder, [owner], []);
  if (listed == "" || listed == "[]") { return 0; }
  return JSON.parse<ApiKeyRow[]>(listed).length;
}

export function refuseApiKey(db: Db, owner: string, name: string, scopes: string): string {
  if (owner == "") { return "signing in is what makes a key yours to keep"; }
  if (name.trim() == "") { return "a key needs a name to be told apart from your others"; }
  if (name.length > MAX_KEY_NAME) { return "\"" + name.slice(0, 20) + "...\" is too long a name"; }
  if (scopes.trim() == "") { return "a key needs at least one product scope: search, retrieve or suggest"; }
  if (keysOwnedCount(db, owner) >= MAX_KEYS_PER_OWNER) {
    return "that is " + `${MAX_KEYS_PER_OWNER}` + " keys already — revoke one before minting another";
  }
  return "";
}

export type ApiKeyMade = {
  id: string,
  secret: string,
  prefix: string,
  problem: string,
};

export function mintApiKey(db: Db, owner: string, name: string, scopesRaw: string, now: string): ApiKeyMade {
  let cleanName = name.trim();
  let scopes = cleanScopes(scopesRaw);
  let wrong = refuseApiKey(db, owner, cleanName, scopes);
  if (wrong != "") {
    let no: ApiKeyMade = { id: "", secret: "", prefix: "", problem: wrong };
    return no;
  }
  let prefix = "jl_" + crypto.randomBytes(4);
  let body = crypto.randomBytes(24);
  let secret = prefix + "_" + body;
  let hash = crypto.sha256(secret);
  let row: ApiKeyRow = {
    id: crypto.randomUUID(),
    owner: owner,
    name: cleanName,
    keyPrefix: prefix,
    keyHash: hash,
    scopes: scopes,
    createdAt: now,
    lastUsedAt: "",
  };
  let written = persist(db, apiKeysMapping(), JSON.stringify(row));
  if (!written.ok) {
    let no: ApiKeyMade = { id: "", secret: "", prefix: "", problem: written.error };
    return no;
  }
  let made: ApiKeyMade = { id: row.id, secret: secret, prefix: prefix, problem: "" };
  return made;
}

export function apiKeyById(db: Db, id: string, owner: string): ApiKeyRow {
  let doc = findById(db, apiKeysMapping(), id);
  if (doc == "") { return emptyApiKey(); }
  let row: ApiKeyRow = JSON.parse<ApiKeyRow>(doc);
  if (row.owner != owner) { return emptyApiKey(); }
  return row;
}

export function forgetApiKey(db: Db, id: string, owner: string): bool {
  let row = apiKeyById(db, id, owner);
  if (row.id == "") { return false; }
  deleteById(db, apiKeysMapping(), id);
  return true;
}

export type ApiKeyAuth = {
  ok: bool,
  owner: string,
  keyId: string,
  scopes: string[],
};

function looksLikeKey(secret: string): bool {
  if (secret.length < 12) { return false; }
  if (secret.slice(0, 3) != "jl_") { return false; }
  return secret.indexOf("_", 3) > 3;
}

export function verifyApiKey(db: Db, secret: string): ApiKeyAuth {
  let miss: ApiKeyAuth = { ok: false, owner: "", keyId: "", scopes: [] };
  if (!looksLikeKey(secret)) { return miss; }
  let hash = crypto.sha256(secret);
  let listed = listWhere(db, apiKeysMapping(), "key_hash = " + db.placeholder, [hash]);
  if (listed == "" || listed == "[]") { return miss; }
  let rows = JSON.parse<ApiKeyRow[]>(listed);
  if (rows.length == 0) { return miss; }
  let row = rows[0];
  let auth: ApiKeyAuth = { ok: true, owner: row.owner, keyId: row.id, scopes: scopeList(row.scopes) };
  return auth;
}

export function touchApiKey(db: Db, id: string, now: string): void {
  db.query("UPDATE api_keys SET last_used_at = " + db.placeholder
    + " WHERE id = " + placeholderAt(db, 2), [now, id]);
}
