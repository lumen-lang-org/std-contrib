import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { ApiKeyAuth, ApiKeyMade, ApiKeyView, apiKeysOf, apiKeysPlan, cleanScopes, forgetApiKey, hasScope, mintApiKey, scopeList, verifyApiKey } from "./api-keys.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_apikeys_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS api_keys");
  migrate(database, apiKeysPlan(database));
}

test("mint returns a secret shown once, and stores only its prefix — never the secret", () => {
  fresh();
  let made = mintApiKey(database, "alice", "prod", "search,retrieve", "t1");
  expect(made.fault == "");
  expect(made.secret.slice(0, 3) == "jl_");
  expect(made.secret.indexOf(made.prefix) == 0);
  let views = JSON.parse<ApiKeyView[]>(apiKeysOf(database, "alice"));
  expect(views.length == 1);
  expect(views[0].name == "prod");
  expect(views[0].keyPrefix == made.prefix);
  expect(views[0].scopes == "search,retrieve");
  expect(apiKeysOf(database, "alice").indexOf("keyHash") < 0);
  expect(apiKeysOf(database, "alice").indexOf(made.secret) < 0);
});

test("a minted secret verifies to its owner and scopes; a wrong one does not", () => {
  fresh();
  let made = mintApiKey(database, "bob", "ci", "search", "t1");
  let auth = verifyApiKey(database, made.secret);
  expect(auth.ok);
  expect(auth.owner == "bob");
  expect(auth.scopes.length == 1);
  expect(auth.scopes[0] == "search");
  expect(!verifyApiKey(database, "nonsense").ok);
  expect(!verifyApiKey(database, "jl_deadbeef_0000000000000000000000000000000000000000000000").ok);
  expect(!verifyApiKey(database, "").ok);
});

test("revoking deletes the row so the secret stops verifying", () => {
  fresh();
  let made = mintApiKey(database, "carol", "temp", "retrieve", "t1");
  expect(verifyApiKey(database, made.secret).ok);
  expect(forgetApiKey(database, made.id, "carol"));
  expect(!verifyApiKey(database, made.secret).ok);
  expect(!forgetApiKey(database, made.id, "carol"));
  let two = mintApiKey(database, "carol", "keep", "search", "t2");
  expect(!forgetApiKey(database, two.id, "mallory"));
  expect(verifyApiKey(database, two.secret).ok);
});

test("scopes are normalised: unknown tokens dropped, wildcard collapses, blank refused", () => {
  fresh();
  expect(cleanScopes("Search, RETRIEVE ,nope") == "search,retrieve");
  expect(cleanScopes("search,*,retrieve") == "*");
  let bad = mintApiKey(database, "dave", "x", "nope,unknown", "t1");
  expect(bad.fault.indexOf("scope") >= 0);
  expect(bad.secret == "");
  expect(hasScope(scopeList("*"), "retrieve"));
  expect(hasScope(scopeList("search,suggest"), "suggest"));
  expect(!hasScope(scopeList("search"), "retrieve"));
});

test("per-owner cap holds", () => {
  fresh();
  let i: int = 0;
  while (i < 20) {
    let m = mintApiKey(database, "eve", "k" + `${i}`, "search", "t1");
    expect(m.fault == "");
    i = i + 1;
  }
  let over = mintApiKey(database, "eve", "one-too-many", "search", "t1");
  expect(over.fault.indexOf("revoke one") >= 0);
  expect(over.secret == "");
  expect(mintApiKey(database, "frank", "fine", "search", "t1").fault == "");
});
