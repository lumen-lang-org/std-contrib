// An OAuth client the operator obtained by hand, against a live database.
//
// The flow around it needs a server to talk to and is covered by
// e2e/oauth-double.mjs. What is here is the half that decides whether a
// connector is configured at all: both credentials go in together, they come
// out together, and neither outlives the connector.
//
//   cd packages/agents && lumen test connect.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, execute, dropTable, findById, persist } from "../plume/plume.ts";
import { migrate, forgetMigrations } from "../plume/migrate.ts";
import { agentsMapping, credentialsMapping, mcpServersMapping, mcpOauthMapping, modelConfigsMapping, modelsMapping, promptsMapping, schemaPlan, McpServerRow, McpOauthRow } from "./schema.ts";
import { hasCredential } from "./credentials.ts";
import { forgetConnector, forgetSuppliedClient, setSuppliedClient, suppliedClientId } from "./connect.ts";

let database: Db = sqlite();

function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_connect_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, mcpOauthMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  // Everything else the plan ALTERs — a column added to a standing table is a
  // duplicate on the second fresh(), and a stopped plan surfaces as failures
  // in whatever this suite happens to touch next.
  execute(database, "DROP TABLE IF EXISTS agent_skills");
  execute(database, "DROP TABLE IF EXISTS skill_files");
  execute(database, "DROP TABLE IF EXISTS skills");
  execute(database, "DROP TABLE IF EXISTS auth_providers");
  execute(database, "DROP TABLE IF EXISTS script_images");
  execute(database, "DROP TABLE IF EXISTS mcp_oauth_grants");
  execute(database, "DROP TABLE IF EXISTS mcp_oauth_pending");
  migrate(database, schemaPlan(database));
}

// A connector row to hang a client off. Built whole; records are immutable.
function server(id: string): void {
  let row: McpServerRow = {
    id: id, serverName: id, transport: "http",
    endpoint: "https://mcp.example.com/mcp",
    authKind: "oauth", authHeader: "", enabled: false,
  };
  persist(database, mcpServersMapping(), JSON.stringify(row));
}

test("a supplied client goes in whole and the id comes back", () => {
  fresh();
  server("s1");
  expect(suppliedClientId(database, "s1", testKey()) == "");

  let refused = setSuppliedClient(database, "s1", "cid-123", "shh-456", testKey());
  expect(refused == "");
  expect(suppliedClientId(database, "s1", testKey()) == "cid-123");
  // The secret is stored, and this module answers nobody who asks for it.
  expect(hasCredential(database, "mcpclient:s1"));
});

test("half a client is no client", () => {
  fresh();
  server("s1");
  // A client id with no secret reaches the consent screen and fails at the
  // token exchange, which is the most confusing place to fail.
  expect(setSuppliedClient(database, "s1", "cid-123", "", testKey()) != "");
  expect(setSuppliedClient(database, "s1", "", "shh-456", testKey()) != "");
  expect(setSuppliedClient(database, "s1", "   ", "  ", testKey()) != "");
  // Nothing was left behind by any of the three.
  expect(suppliedClientId(database, "s1", testKey()) == "");
  expect(!hasCredential(database, "mcpclientid:s1"));
});

test("supplying a client drops the registration built around the old one", () => {
  fresh();
  server("s1");
  // A registration this deployment made for itself earlier.
  let cached: McpOauthRow = {
    id: "s1", issuer: "https://mcp.example.com",
    authorizeUrl: "https://mcp.example.com/authorize",
    tokenUrl: "https://mcp.example.com/token",
    clientId: "registered-me", scope: "",
    redirectUri: "https://joule.sh/api/connect/callback",
    registeredAt: "t0",
  };
  persist(database, mcpOauthMapping(), JSON.stringify(cached));
  expect(findById(database, mcpOauthMapping(), "s1") != "");

  setSuppliedClient(database, "s1", "cid-123", "shh-456", testKey());
  // Left standing, the next Connect would sign in as the wrong application.
  expect(findById(database, mcpOauthMapping(), "s1") == "");
});

test("forgetting a client takes both halves and the registration", () => {
  fresh();
  server("s1");
  setSuppliedClient(database, "s1", "cid-123", "shh-456", testKey());
  forgetSuppliedClient(database, "s1");
  expect(suppliedClientId(database, "s1", testKey()) == "");
  expect(!hasCredential(database, "mcpclientid:s1"));
  expect(!hasCredential(database, "mcpclient:s1"));
});

test("forgetting the connector takes the client with it", () => {
  fresh();
  server("s1");
  setSuppliedClient(database, "s1", "cid-123", "shh-456", testKey());
  // A credential outliving the connector that named it is a leak waiting for
  // an id to be recycled — forgetServer's rule, held here too.
  forgetConnector(database, "s1", testKey());
  expect(!hasCredential(database, "mcpclientid:s1"));
  expect(!hasCredential(database, "mcpclient:s1"));
});

test("one connector's client is not another's", () => {
  fresh();
  server("s1");
  server("s2");
  setSuppliedClient(database, "s1", "cid-one", "shh-one", testKey());
  setSuppliedClient(database, "s2", "cid-two", "shh-two", testKey());
  expect(suppliedClientId(database, "s1", testKey()) == "cid-one");
  expect(suppliedClientId(database, "s2", testKey()) == "cid-two");
  forgetSuppliedClient(database, "s1");
  expect(suppliedClientId(database, "s2", testKey()) == "cid-two");
});
