// Credentials, encrypted at rest, against a live database.
//
//   cd packages/agents && lumen test credentials.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, findById, execute, dropTable, countWhere } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { CredentialRow, credentialsMapping, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, schemaPlan } from "./schema.ts";
import { DestinationMove, masterKey, masterKeyProblem, storeCredential, credentialFor, providersWithCredentials, hasCredential, forgetCredential, destinationOf, destinationProblem } from "./credentials.ts";

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
  expect(storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" }) == "");
  expect(credentialFor(database, "mistral", testKey()) == "sk-fake-mistral-0001");
});

test("the plaintext is nowhere in the table", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  let row: CredentialRow = JSON.parse<CredentialRow>(findById(database, credentialsMapping(), "cred-mistral"));
  expect(row.envelope.indexOf("sk-fake") < 0);
  expect(row.envelope != "sk-fake-mistral-0001");
  expect(row.provider == "mistral");
});

test("two providers keep separate credentials", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  storeCredential(database, { provider: "anthropic", apiKey: "sk-fake-anthropic-0002", masterKey: testKey(), now: "t" });
  expect(credentialFor(database, "mistral", testKey()) == "sk-fake-mistral-0001");
  expect(credentialFor(database, "anthropic", testKey()) == "sk-fake-anthropic-0002");
});

test("storing again replaces rather than duplicating", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-first", masterKey: testKey(), now: "t" });
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-second", masterKey: testKey(), now: "t" });
  expect(countWhere(database, credentialsMapping(), "", []) == 1);
  expect(credentialFor(database, "mistral", testKey()) == "sk-fake-second");
});

test("an empty key is not a credential", () => {
  fresh();
  // An empty plaintext would encrypt to a valid envelope that decrypts to "",
  // which cannot be told from a failure to open it.
  expect(storeCredential(database, { provider: "mistral", apiKey: "", masterKey: testKey(), now: "t" }).indexOf("empty") >= 0);
  expect(countWhere(database, credentialsMapping(), "", []) == 0);
});

test("storing refuses outright without a usable master key", () => {
  fresh();
  expect(storeCredential(database, { provider: "mistral", apiKey: "sk-fake", masterKey: "", now: "t" }).indexOf("not set") >= 0);
  expect(storeCredential(database, { provider: "mistral", apiKey: "sk-fake", masterKey: "nope", now: "t" }).indexOf("32") >= 0);
  expect(countWhere(database, credentialsMapping(), "", []) == 0);
});

// --- reading, and what reading refuses ----------------------------------------

test("the wrong master key opens nothing", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  expect(credentialFor(database, "mistral", "fedcba9876543210fedcba9876543210") == "");
});

test("a row altered in the database refuses to open", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
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
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  // Absent, wrong key, and altered all answer "". A caller that could tell
  // them apart could use this to test master keys against the table.
  expect(credentialFor(database, "openai", testKey()) == "");
  expect(credentialFor(database, "mistral", "fedcba9876543210fedcba9876543210") == "");
  expect(credentialFor(database, "mistral", "bad") == "");
});

test("listing names providers and never envelopes", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  storeCredential(database, { provider: "anthropic", apiKey: "sk-fake-anthropic-0002", masterKey: testKey(), now: "t" });
  let names = providersWithCredentials(database);
  expect(names.length == 2);
  expect(names.indexOf("mistral") >= 0);
  expect(names.indexOf("anthropic") >= 0);
});

// --- knowing a secret is there, and getting rid of it -------------------------

test("a credential can be asked after without being opened", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  expect(hasCredential(database, "mistral"));
  expect(!hasCredential(database, "openai"));
  // Deliberately not asking for the master key: a caller deciding whether a
  // secret is at stake must not fail open when the key is wrong.
  expect(hasCredential(database, "mistral"));
});

test("forgetting a credential says whether there was one", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  expect(forgetCredential(database, "mistral"));
  expect(credentialFor(database, "mistral", testKey()) == "");
  expect(countWhere(database, credentialsMapping(), "", []) == 0);
  // Twice is not an error, and is not a lie either.
  expect(!forgetCredential(database, "mistral"));
});

// --- where a secret is allowed to go ------------------------------------------

test("a destination is its origin, however the rest of the URL is written", () => {
  expect(destinationOf("https://api.mistral.ai/v1/chat/completions") == "https://api.mistral.ai");
  expect(destinationOf("HTTPS://API.Mistral.AI/v1") == "https://api.mistral.ai");
  expect(destinationOf("http://127.0.0.1:11434/v1/embeddings") == "http://127.0.0.1:11434");
  // A port is part of who receives this, so it is part of the answer.
  expect(destinationOf("https://gw.internal:8443/v1") != destinationOf("https://gw.internal/v1"));
  // User-info is not part of where this goes, and would otherwise make one
  // host compare unequal with itself.
  expect(destinationOf("https://user:pw@gw.internal/v1") == "https://gw.internal");
});

test("an address with no origin to read is no address", () => {
  expect(destinationOf("") == "");
  expect(destinationOf("api.mistral.ai") == "");
  expect(destinationOf("file:///etc/passwd") == "");
  expect(destinationOf("https://") == "");
});

function move(was: string, now: string, stored: bool): DestinationMove {
  let m: DestinationMove = {
    subject: "model m1",
    secretName: "the mistral key",
    clearWith: "DELETE /providers/mistral/key",
    was: was,
    now: now,
    secretStored: stored,
  };
  return m;
}

test("a stored secret cannot be pointed at another host", () => {
  let refused = destinationProblem(move("https://api.mistral.ai/v1", "http://attacker.example/v1", true));
  expect(refused != "");
  expect(refused.indexOf("attacker.example") >= 0);
  // A refusal that does not say what to do next is a locked door with no sign.
  expect(refused.indexOf("DELETE /providers/mistral/key") >= 0);
});

test("the same host by another path is not a move", () => {
  expect(destinationProblem(move("https://api.mistral.ai/v1", "https://api.mistral.ai/v2/chat", true)) == "");
});

test("with nothing stored there is nothing to refuse", () => {
  expect(destinationProblem(move("https://api.mistral.ai/v1", "http://attacker.example/v1", false)) == "");
});

test("an unreadable address on either side refuses rather than passes", () => {
  // Fails closed twice: a new address this cannot parse is somewhere else, and
  // an old one it cannot parse is not evidence that the new one is the same.
  expect(destinationProblem(move("https://api.mistral.ai/v1", "notaurl", true)) != "");
  expect(destinationProblem(move("", "https://api.mistral.ai/v1", true)) != "");
  expect(destinationProblem(move("", "", true)) != "");
});

test("the suite leaves nothing behind", () => {
  fresh();
  expect(dropTable(database, credentialsMapping()).ok);
  database.close();
});
