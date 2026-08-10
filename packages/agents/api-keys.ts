// API keys — a standing credential a person mints to call Joule's public
// products (search, retrieve, suggest) from their own code.
//
// The shape is the one already proven in the Nuraly gateway, held to here for
// the same reasons: the secret is shown once, at creation, and never again —
// the row keeps only its SHA-256 hash and a visible prefix. A presented key is
// hashed and looked up by that hash, so a stolen row discloses nothing usable,
// and revoking a key is deleting the row its hash lives in. Scopes gate which
// product a key may call; `verifyApiKey` is the single door the /v1 gateway
// knocks on, and the only place a hash is ever compared.

import { Db } from "../plume/driver.ts";
import { DbField, DbOrder, DbRepository, asc, createTableSql, deleteById, field, findById, listOrdered, listWhere, persist, placeholderAt, repository } from "../plume/plume.ts";
import { Migration, migration } from "../plume/migrate.ts";

// Bounded where every per-owner thing is bounded, at a number nobody real
// reaches — the secrets table's own ceiling, held to so the two feel the same.
export const MAX_KEYS_PER_OWNER: int = 20;
export const MAX_KEY_NAME: int = 60;

// The products a key may be scoped to — one token per public Joule endpoint. A
// flat list, not resource:action, because here the products ARE the resources:
// a caller either may retrieve or may not. "*" is every product, present and
// future.
export const JOULE_SCOPES: string[] = ["search", "retrieve", "suggest"];

export type ApiKeyRow = {
  id: string,
  // Whose it is. Every read, every write and every verify is scoped by this.
  owner: string,
  // What a person calls it in the list: "prod-rag-service", "ci".
  name: string,
  // The visible half — "jl_1a2b3c4d". Enough to tell two keys apart in a
  // list, useless as a credential on its own.
  keyPrefix: string,
  // SHA-256 of the whole secret. The only shadow of the secret that survives
  // creation; the secret itself is shown once and stored nowhere.
  keyHash: string,
  // Comma-separated product tokens, e.g. "search,retrieve". "*" means all.
  scopes: string,
  createdAt: string,
  // Stamped on every verified call (best-effort) so the list can say which
  // keys are alive and which are candidates to revoke.
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
  // 115: discover.ts owns 114, mcp-roster.ts owns 113 — a migration that
  // sorts below one already applied refuses the whole plan.
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

// A row is never sent with its hash — the list route answers this instead, the
// same row minus the one column that must not travel.
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

// Lowercased, comma-separated, only the tokens Joule knows — the shape stored,
// normalised once here rather than at every read. An unknown token is dropped,
// never broadening a key past what exists; "*" short-circuits to every product.
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

/** The scopes of a key as a list — ["*"] for the wildcard. */
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

/** Whether a granted scope list satisfies a required product token. */
export function hasScope(granted: string[], required: string): bool {
  let i: int = 0;
  while (i < granted.length) {
    if (granted[i] == "*") { return true; }
    if (granted[i] == required) { return true; }
    i = i + 1;
  }
  return false;
}

/** This owner's keys, viewed — named and prefixed, never hashed. */
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

// How many keys this owner already holds — the cap is counted, not hoped about.
function keysOwnedCount(db: Db, owner: string): int {
  let listed = listOrdered(db, apiKeysMapping(), "owner = " + db.placeholder, [owner], []);
  if (listed == "" || listed == "[]") { return 0; }
  return JSON.parse<ApiKeyRow[]>(listed).length;
}

/** Why this key cannot be minted, or "". */
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
  // The whole secret, "jl_<prefix>_<random>". Returned once, by mint, and by
  // nothing else ever — the caller has this line or has lost the key.
  secret: string,
  prefix: string,
  problem: string,
};

/** Mint a key: build the secret, store its hash and prefix, hand the secret
 *  back exactly once. The row is written only after the secret is formed, so
 *  there is never a named key that opens to nothing — and never a secret in a
 *  column, because there is no column for one. */
export function mintApiKey(db: Db, owner: string, name: string, scopesRaw: string, now: string): ApiKeyMade {
  let cleanName = name.trim();
  let scopes = cleanScopes(scopesRaw);
  let wrong = refuseApiKey(db, owner, cleanName, scopes);
  if (wrong != "") {
    let no: ApiKeyMade = { id: "", secret: "", prefix: "", problem: wrong };
    return no;
  }
  // 8 hex of prefix (the visible half) and 48 hex of body — 24 random bytes is
  // the secret's whole strength; the prefix is only a label.
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

/** One key, if it is this owner's — somebody else's is absent, not forbidden. */
export function apiKeyById(db: Db, id: string, owner: string): ApiKeyRow {
  let doc = findById(db, apiKeysMapping(), id);
  if (doc == "") { return emptyApiKey(); }
  let row: ApiKeyRow = JSON.parse<ApiKeyRow>(doc);
  if (row.owner != owner) { return emptyApiKey(); }
  return row;
}

/** Revoke a key by deleting the row its hash lives in — the hash gone is the
 *  key dead, with no window where a revoked secret still verifies. True when
 *  there was one to revoke. */
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
  // A prefix underscore and a body underscore — "jl_<prefix>_<body>".
  return secret.indexOf("_", 3) > 3;
}

/** Verify a presented secret. The one place a hash is compared: the secret is
 *  hashed and the row is fetched by that hash, so a wrong key, a made-up key
 *  and a revoked key are all simply absent. Returns the owner and scopes the
 *  gateway needs, or ok:false. */
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

/** Stamp a use. Best-effort: a verified call must not fail over a stamp. */
export function touchApiKey(db: Db, id: string, now: string): void {
  db.query("UPDATE api_keys SET last_used_at = " + db.placeholder
    + " WHERE id = " + placeholderAt(db, 2), [now, id]);
}
