// What the API refuses, and what it takes with it when it deletes something.
//
// The routes themselves are methods on `@controller` classes, and a class is
// not something a Lumen module can export — so what a route decides lives in a
// free function beside it and is asked here directly, against a real database.
// Every case below is one an operator can reach with one curl.
//
//   cd packages/agents && lumen test api.test.ts

import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, executeWith, findById, countWhere, dropTable } from "../plume/plume.ts";
import { migrate, migration, forgetMigrations } from "../plume/migrate.ts";
import { ModelRow, McpServerRow, AgentRow, modelsMapping, modelConfigsMapping, promptsMapping, mcpServersMapping, agentsMapping, credentialsMapping } from "./schema.ts";
import { TraceConfigRow, traceConfigMapping } from "./trace.ts";
import { AgentRetrievalRow, agentRetrievalMapping, grantScope, agentScopes } from "./knowledge.ts";
import { storeCredential, credentialFor } from "./credentials.ts";
import { migrationProblem, modelProblem, modelDestinationProblem, serverDestinationProblem, traceDestinationProblem, forgetServer, forgetAgent } from "./api.ts";

let database: Db = sqlite();

// A fixed master key, so the suite is repeatable. A real one comes from the
// environment.
function testKey(): string {
  return "0123456789abcdef0123456789abcdef";
}

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_api_track_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  execute(database, "DROP TABLE IF EXISTS agent_sub_agents");
  execute(database, "DROP TABLE IF EXISTS agent_mcp_servers");
  execute(database, "DROP TABLE IF EXISTS agent_scopes");
  execute(database, "DROP TABLE IF EXISTS agent_retrieval");
  execute(database, "DROP TABLE IF EXISTS documents");
  execute(database, "DROP TABLE IF EXISTS trace_config");
  execute(database, "DROP INDEX IF EXISTS prompts_by_name");
  execute(database, "DROP INDEX IF EXISTS scopes_by_agent");
  dropTable(database, credentialsMapping());
  dropTable(database, agentsMapping());
  dropTable(database, mcpServersMapping());
  dropTable(database, promptsMapping());
  dropTable(database, modelConfigsMapping(database));
  dropTable(database, modelsMapping());
  migrationProblem(database);
}

function modelRow(id: string, provider: string, kind: string, baseUrl: string): ModelRow {
  let m: ModelRow = {
    id: id, label: "L " + id, apiName: "some-model", provider: provider,
    kind: kind, dimensions: kind == "embedding" ? 1024 : 0,
    baseUrl: baseUrl, enabled: true,
  };
  return m;
}

function mcpRow(id: string, endpoint: string): McpServerRow {
  let s: McpServerRow = {
    id: id, serverName: "demo " + id, transport: "http", endpoint: endpoint,
    authKind: "bearer", authHeader: "", enabled: true,
  };
  return s;
}

function traceRow(endpoint: string): TraceConfigRow {
  let t: TraceConfigRow = {
    id: "default", backend: "langfuse", endpoint: endpoint, publicKey: "pk-lf-1",
    serviceName: "agents", environment: "test", enabled: true,
  };
  return t;
}

// --- a write-only secret stays write-only ------------------------------------

test("a model's base URL cannot be moved while its provider's key is stored", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });

  // The attack: repoint the row, then press "test". The key travels.
  let moved = modelDestinationProblem(database, modelRow("m1", "mistral", "chat", "http://attacker.example/v1"));
  expect(moved != "");
  // A refusal has to say what to do next, or it is just a locked door.
  expect(moved.indexOf("attacker.example") >= 0);
  expect(moved.indexOf("DELETE /providers/mistral/key") >= 0);
});

test("a model created against a foreign base URL is refused just as a moved one is", () => {
  fresh();
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  // No row exists yet, so there is nothing to "change" — and a fresh row
  // naming someone else's host leaks exactly as much as an edited one.
  let created = modelDestinationProblem(database, modelRow("m9", "mistral", "chat", "http://attacker.example/v1"));
  expect(created != "");
  expect(created.indexOf("attacker.example") >= 0);
});

test("a model whose provider changes is refused, because that changes the key too", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  storeCredential(database, { provider: "openai", apiKey: "sk-fake-openai-0002", masterKey: testKey(), now: "t" });
  let switched = modelDestinationProblem(database, modelRow("m1", "openai", "chat", ""));
  expect(switched != "");
});

test("an edit that leaves the address alone is allowed", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  let renamed: ModelRow = {
    id: "m1", label: "A better label", apiName: "mistral-small-latest", provider: "mistral",
    kind: "chat", dimensions: 0, baseUrl: "", enabled: false,
  };
  expect(modelDestinationProblem(database, renamed) == "");
});

test("a path change on the same host is not a move", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "https://gw.internal/v1")));
  storeCredential(database, { provider: "mistral", apiKey: "sk-fake-mistral-0001", masterKey: testKey(), now: "t" });
  expect(modelDestinationProblem(database, modelRow("m1", "mistral", "chat", "https://gw.internal/v2")) == "");
  // A different host on the same path is.
  expect(modelDestinationProblem(database, modelRow("m1", "mistral", "chat", "https://gw.attacker/v1")) != "");
});

test("with no key stored there is nothing to protect and nothing is refused", () => {
  fresh();
  persist(database, modelsMapping(), JSON.stringify(modelRow("m1", "mistral", "chat", "")));
  expect(modelDestinationProblem(database, modelRow("m1", "mistral", "chat", "http://anywhere.example/v1")) == "");
});

test("a base URL that is not an address is refused where it is written", () => {
  // Unreadable here means uncomparable later: nothing can decide whether it is
  // where the key was stored for.
  expect(modelProblem(modelRow("m1", "mistral", "chat", "notaurl")).indexOf("base URL") >= 0);
  expect(modelProblem(modelRow("m1", "mistral", "chat", "file:///etc/passwd")).indexOf("base URL") >= 0);
  // An empty one is how "use the provider's own endpoint" is spelled.
  expect(modelProblem(modelRow("m1", "mistral", "chat", "")) == "");
  expect(modelProblem(modelRow("m1", "mistral", "chat", "https://gw.internal/v1")) == "");
});

test("an MCP server's endpoint cannot be moved while its token is stored", () => {
  fresh();
  persist(database, mcpServersMapping(), JSON.stringify(mcpRow("s1", "https://mcp.example/mcp")));
  storeCredential(database, { provider: "mcp:s1", apiKey: "mcp-fake-token", masterKey: testKey(), now: "t" });

  let moved = serverDestinationProblem(database, mcpRow("s1", "http://attacker.example/mcp"));
  expect(moved != "");
  expect(moved.indexOf("attacker.example") >= 0);
  expect(moved.indexOf("/servers/s1/auth") >= 0);
});

test("an MCP server keeping its endpoint is written without complaint", () => {
  fresh();
  persist(database, mcpServersMapping(), JSON.stringify(mcpRow("s1", "https://mcp.example/mcp")));
  storeCredential(database, { provider: "mcp:s1", apiKey: "mcp-fake-token", masterKey: testKey(), now: "t" });
  expect(serverDestinationProblem(database, mcpRow("s1", "https://mcp.example/mcp")) == "");
});

test("the trace collector cannot be moved while its secret is stored", () => {
  fresh();
  persist(database, traceConfigMapping(), JSON.stringify(traceRow("https://cloud.langfuse.com")));
  storeCredential(database, { provider: "tracing", apiKey: "sk-lf-fake", masterKey: testKey(), now: "t" });

  let moved = traceDestinationProblem(database, traceRow("http://attacker.example"));
  expect(moved != "");
  expect(moved.indexOf("attacker.example") >= 0);
  expect(moved.indexOf("DELETE /tracing/key") >= 0);
});

test("an address that cannot be read is treated as somewhere else", () => {
  fresh();
  persist(database, traceConfigMapping(), JSON.stringify(traceRow("https://cloud.langfuse.com")));
  storeCredential(database, { provider: "tracing", apiKey: "sk-lf-fake", masterKey: testKey(), now: "t" });
  // Not a URL this can parse. Refusing beats guessing.
  expect(traceDestinationProblem(database, traceRow("cloud.langfuse.com")) != "");
});

// --- deleting a row takes its secrets and its links with it -------------------

test("deleting an MCP server deletes its stored token", () => {
  fresh();
  persist(database, mcpServersMapping(), JSON.stringify(mcpRow("s1", "https://mcp.example/mcp")));
  storeCredential(database, { provider: "mcp:s1", apiKey: "mcp-fake-token", masterKey: testKey(), now: "t" });
  expect(credentialFor(database, "mcp:s1", testKey()) == "mcp-fake-token");

  forgetServer(database, "s1");

  // Ids are short human strings chosen by the caller, so "s1" comes back. If
  // the token outlives the row, the next server called s1 is handed the old
  // one's secret and sends it wherever it points.
  expect(credentialFor(database, "mcp:s1", testKey()) == "");
  expect(countWhere(database, credentialsMapping(), "", []) == 0);
});

test("deleting an agent takes its scopes, its retrieval row and its parents' links", () => {
  fresh();
  let a1: AgentRow = { id: "a1", agentName: "lead", description: "d", modelConfigId: "c1", promptId: "p1", isDefault: true, enabled: true, updatedAt: "t" };
  let a2: AgentRow = { id: "a2", agentName: "scout", description: "d", modelConfigId: "c1", promptId: "p1", isDefault: false, enabled: true, updatedAt: "t" };
  persist(database, agentsMapping(), JSON.stringify(a1));
  persist(database, agentsMapping(), JSON.stringify(a2));
  execute(database, "INSERT INTO agent_sub_agents VALUES ('a1','a2')");
  grantScope(database, "a2", "/specs");
  let retrieval: AgentRetrievalRow = { agentId: "a2", embeddingModelId: "e1", topK: 5, maxDistance: 1.0, enabled: true };
  persist(database, agentRetrievalMapping(), JSON.stringify(retrieval));

  forgetAgent(database, "a2");

  // Recreate the id and the new agent must start with nothing: no corpus it
  // was never granted, and no parent silently re-attached to it.
  expect(agentScopes(database, "a2").length == 0);
  expect(findById(database, agentRetrievalMapping(), "a2") == "");
  execute(database, "SELECT parent_id FROM agent_sub_agents WHERE child_id = 'a2'");
  expect(database.rows() == 0);
});

// --- a half-migrated schema is not something to serve on ----------------------

test("a migration that fails stops the server rather than being logged", () => {
  fresh();
  // A history holding a version this build's plan sits entirely below is what
  // a rolled-back deploy looks like from the database's side, and migrate
  // refuses to run beneath it rather than guessing.
  forgetMigrations(database);
  migrate(database, [migration("9999", "from a future build", "SELECT 1")]);
  let problem = migrationProblem(database);
  expect(problem != "");
  // Naming the schema is the point: "could not connect" and "your database is
  // one release ahead" are different mornings.
  expect(problem.indexOf("schema") >= 0);
});
