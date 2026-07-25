// Credentials, encrypted at rest, against a live database.
//
//   cd packages/agents && lumen test credentials.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, findById, execute, dropTable, countWhere } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { CredentialRow, credentialsMapping, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, schemaPlan } from "./schema.ts";
import { masterKey, masterKeyProblem, storeCredential, credentialFor, providersWithCredentials } from "./credentials.ts";

let database: Db = sqlite();

// A fixed key so the suite is repeatable. A real one comes from the
// environment and is never written down.
function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_cred_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  migrate(database, schemaPlan(database));
}

// --- the master key ----------------------------------------------------------

test("a missing or wrong-length master key is refused, saying which", () => {
  expect(masterKeyProblem("").indexOf("not set") >= 0);
  expect(masterKeyProblem("short").indexOf("32") >= 0);
  expect(masterKeyProblem("short").indexOf("5 bytes") >= 0);
  expect(masterKeyProblem(testKey()) == "");
});

// --- storing -----------------------------------------------------------------

test("a stored credential comes back", () => {
  fresh();
  expect(storeCredential(database, "mistral", "sk-fake-mistral-0001", testKey(), "t") == "");
  expect(credentialFor(database, "mistral", testKey()) == "sk-fake-mistral-0001");
});

test("the plaintext is nowhere in the table", () => {
  fresh();
  storeCredential(database, "mistral", "sk-fake-mistral-0001", testKey(), "t");
  let row: CredentialRow = JSON.parse<CredentialRow>(findById(database, credentialsMapping(), "cred-mistral"));
  expect(row.envelope.indexOf("sk-fake") < 0);
  expect(row.envelope != "sk-fake-mistral-0001");
  expect(row.provider == "mistral");
});

test("two providers keep separate credentials", () => {
  fresh();
  storeCredential(database, "mistral", "sk-fake-mistral-0001", testKey(), "t");
  storeCredential(database, "anthropic", "sk-fake-anthropic-0002", testKey(), "t");
  expect(credentialFor(database, "mistral", testKey()) == "sk-fake-mistral-0001");
  expect(credentialFor(database, "anthropic", testKey()) == "sk-fake-anthropic-0002");
});

test("storing again replaces rather than duplicating", () => {
  fresh();
  storeCredential(database, "mistral", "sk-fake-first", testKey(), "t");
  storeCredential(database, "mistral", "sk-fake-second", testKey(), "t");
  expect(countWhere(database, credentialsMapping(), "", []) == 1);
  expect(credentialFor(database, "mistral", testKey()) == "sk-fake-second");
});

test("an empty key is not a credential", () => {
  fresh();
  // An empty plaintext would encrypt to a valid envelope that decrypts to "",
  // which cannot be told from a failure to open it.
  expect(storeCredential(database, "mistral", "", testKey(), "t").indexOf("empty") >= 0);
  expect(countWhere(database, credentialsMapping(), "", []) == 0);
});

test("storing refuses outright without a usable master key", () => {
  fresh();
  expect(storeCredential(database, "mistral", "sk-fake", "", "t").indexOf("not set") >= 0);
  expect(storeCredential(database, "mistral", "sk-fake", "nope", "t").indexOf("32") >= 0);
  expect(countWhere(database, credentialsMapping(), "", []) == 0);
});

// --- reading, and what reading refuses ----------------------------------------

test("the wrong master key opens nothing", () => {
  fresh();
  storeCredential(database, "mistral", "sk-fake-mistral-0001", testKey(), "t");
  expect(credentialFor(database, "mistral", "fedcba9876543210fedcba9876543210") == "");
});

test("a row altered in the database refuses to open", () => {
  fresh();
  storeCredential(database, "mistral", "sk-fake-mistral-0001", testKey(), "t");
  let row: CredentialRow = JSON.parse<CredentialRow>(findById(database, credentialsMapping(), "cred-mistral"));
  // Change one character of the envelope, as an attacker with write access
  // would. The tag catches it; without an authenticated cipher this would
  // decrypt to something and the caller would send it to a provider.
  let head = row.envelope.substring(0, 20);
  let ch = row.envelope.substring(20, 21);
  let rest = row.envelope.substring(21, row.envelope.length);
  let tampered = head + (ch == "A" ? "B" : "A") + rest;
  execute(database, "UPDATE provider_credentials SET envelope = '" + tampered + "' WHERE id = 'cred-mistral'");
  expect(credentialFor(database, "mistral", testKey()) == "");
});

test("a provider with no credential reads as empty, not as an error", () => {
  fresh();
  expect(credentialFor(database, "openai", testKey()) == "");
});

test("every failure to open looks the same", () => {
  fresh();
  storeCredential(database, "mistral", "sk-fake-mistral-0001", testKey(), "t");
  // Absent, wrong key, and altered all answer "". A caller that could tell
  // them apart could use this to test master keys against the table.
  expect(credentialFor(database, "openai", testKey()) == "");
  expect(credentialFor(database, "mistral", "fedcba9876543210fedcba9876543210") == "");
  expect(credentialFor(database, "mistral", "bad") == "");
});

test("listing names providers and never envelopes", () => {
  fresh();
  storeCredential(database, "mistral", "sk-fake-mistral-0001", testKey(), "t");
  storeCredential(database, "anthropic", "sk-fake-anthropic-0002", testKey(), "t");
  let names = providersWithCredentials(database);
  expect(names.length == 2);
  expect(names.indexOf("mistral") >= 0);
  expect(names.indexOf("anthropic") >= 0);
});

test("the suite leaves nothing behind", () => {
  fresh();
  expect(dropTable(database, credentialsMapping()).ok);
  database.close();
});
