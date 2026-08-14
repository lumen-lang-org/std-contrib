import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { apiKeysPlan } from "./api-keys.ts";
import { ApiKeyService } from "./routes/api-keys/api-key.service.ts";
import { ApiKeyView, cleanScopes, hasScope, scopeList } from "./routes/api-keys/api-key.utils.ts";

let database: Db = sqlite();

function fresh(): ApiKeyService {
  let cfg: DbConfig = { filename: "/tmp/agents_apikeys_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS api_keys");
  migrate(database, apiKeysPlan(database));
  return new ApiKeyService(database);
}

test("mint returns a secret shown once, and stores only its prefix — never the secret", () => {
  let keys = fresh();
  let made = keys.mint("alice", "prod", "search,retrieve", "t1");
  expect(made.fault == "");
  expect(made.secret.slice(0, 3) == "jl_");
  expect(made.secret.indexOf(made.prefix) == 0);
  let views = JSON.parse<ApiKeyView[]>(keys.listing("alice"));
  expect(views.length == 1);
  expect(views[0].name == "prod");
  expect(views[0].keyPrefix == made.prefix);
  expect(views[0].scopes == "search,retrieve");
  expect(keys.listing("alice").indexOf("keyHash") < 0);
  expect(keys.listing("alice").indexOf(made.secret) < 0);
});

test("a minted secret verifies to its owner and scopes; a wrong one does not", () => {
  let keys = fresh();
  let made = keys.mint("bob", "ci", "search", "t1");
  let auth = keys.verify(made.secret);
  expect(auth.ok);
  expect(auth.owner == "bob");
  expect(auth.scopes.length == 1);
  expect(auth.scopes[0] == "search");
  expect(!keys.verify("nonsense").ok);
  expect(!keys.verify("jl_deadbeef_0000000000000000000000000000000000000000000000").ok);
  expect(!keys.verify("").ok);
});

test("revoking deletes the row so the secret stops verifying", () => {
  let keys = fresh();
  let made = keys.mint("carol", "temp", "retrieve", "t1");
  expect(keys.verify(made.secret).ok);
  expect(keys.forget(made.id, "carol"));
  expect(!keys.verify(made.secret).ok);
  expect(!keys.forget(made.id, "carol"));
  let two = keys.mint("carol", "keep", "search", "t2");
  expect(!keys.forget(two.id, "mallory"));
  expect(keys.verify(two.secret).ok);
});

test("scopes are normalised: unknown tokens dropped, wildcard collapses, blank refused", () => {
  let keys = fresh();
  expect(cleanScopes("Search, RETRIEVE ,nope") == "search,retrieve");
  expect(cleanScopes("search,*,retrieve") == "*");
  let bad = keys.mint("dave", "x", "nope,unknown", "t1");
  expect(bad.fault.indexOf("scope") >= 0);
  expect(bad.secret == "");
  expect(hasScope(scopeList("*"), "retrieve"));
  expect(hasScope(scopeList("search,suggest"), "suggest"));
  expect(!hasScope(scopeList("search"), "retrieve"));
});

test("per-owner cap holds", () => {
  let keys = fresh();
  let i: int = 0;
  while (i < 20) {
    let m = keys.mint("eve", "k" + `${i}`, "search", "t1");
    expect(m.fault == "");
    i = i + 1;
  }
  let over = keys.mint("eve", "one-too-many", "search", "t1");
  expect(over.fault.indexOf("revoke one") >= 0);
  expect(over.secret == "");
  expect(keys.mint("frank", "fine", "search", "t1").fault == "");
});
