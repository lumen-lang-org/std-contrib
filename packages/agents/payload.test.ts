import { Db, DbConfig } from "../plume/driver.ts";
import { sqlite } from "../plume/sqlite.ts";
import { connectDatabase, persist, execute, dropTable, createTableSql } from "../plume/plume.ts";
import { forgetMigrations } from "../plume/migrate.ts";
import { AgentRow, agentsMapping } from "./schema.ts";
import { ScopeNode } from "./knowledge.ts";
import { jsonId, createFault, backendOr, knownBackend, scopesJson } from "./payload.ts";

let database: Db = sqlite();

function fresh(): void {
  let cfg: DbConfig = { filename: "/tmp/agents_payload_test.db" };
  connectDatabase(database, cfg);
  forgetMigrations(database);
  dropTable(database, agentsMapping());
  execute(database, createTableSql(database, agentsMapping()));
}

test("an id is read out of a document", () => {
  expect(jsonId("{\"id\":\"support\",\"name\":\"Support\"}") == "support");
});

test("an id is found wherever it sits", () => {
  expect(jsonId("{\"name\":\"Support\",\"id\":\"support\"}") == "support");
});

test("spacing around the colon does not hide it", () => {
  expect(jsonId("{ \"id\" : \"support\" }") == "support");
  expect(jsonId("{\n  \"id\":\n  \"support\"\n}") == "support");
});

test("a document with no id reads as none", () => {
  expect(jsonId("{\"name\":\"Support\"}") == "");
  expect(jsonId("") == "");
  expect(jsonId("{}") == "");
});

test("a key that ends in id is not the id", () => {
  expect(jsonId("{\"model_id\":\"gpt\",\"id\":\"support\"}") == "support");
  expect(jsonId("{\"model_id\":\"gpt\"}") == "");
});

test("an empty id reads as none rather than as an empty string", () => {
  expect(jsonId("{\"id\":\"\"}") == "");
});

test("a numeric id is not read as the next key", () => {
  expect(jsonId("{\"id\":7,\"name\":\"support\"}") == "");
  expect(jsonId("{\"id\":null,\"name\":\"support\"}") == "");
});

test("an unterminated id reads as none", () => {
  expect(jsonId("{\"id\":\"support") == "");
});

test("a create with no body is refused by name", () => {
  fresh();
  expect(createFault(database, agentsMapping(), "") == "a body is required");
});

test("a create with no id is refused by name", () => {
  fresh();
  let why = createFault(database, agentsMapping(), "{\"name\":\"Support\"}");
  expect(why.indexOf("\"id\"") >= 0);
});

test("a create on a free id goes ahead", () => {
  fresh();
  expect(createFault(database, agentsMapping(), "{\"id\":\"support\"}") == "");
});

test("a create on a taken id is refused, and says what to use instead", () => {
  fresh();
  let row: AgentRow = {
    id: "support", agentName: "Support", description: "",
    modelConfigId: "cfg", promptId: "p", scriptImageId: "", isDefault: false, enabled: true, updatedAt: "",
  };
  persist(database, agentsMapping(), JSON.stringify(row));

  let why = createFault(database, agentsMapping(), "{\"id\":\"support\",\"name\":\"Other\"}");
  expect(why.indexOf("already exists") >= 0);
  expect(why.indexOf("PUT") >= 0);
});

test("an unset backend means langfuse, which is what the column used to imply", () => {
  expect(backendOr("") == "langfuse");
  expect(backendOr("otlp") == "otlp");
});

test("every backend the tracing package serves is accepted here", () => {
  expect(knownBackend("langfuse"));
  expect(knownBackend("otlp"));
  expect(knownBackend("phoenix"));
  expect(knownBackend("braintrust"));
  expect(knownBackend("langsmith"));
  expect(knownBackend("arize"));
});

test("a typo is refused when it is set, not obeyed later", () => {
  expect(!knownBackend("langfus"));
  expect(!knownBackend("Langfuse"));
  expect(!knownBackend(""));
  expect(!knownBackend("datadog"));
});

function node(path: string, documents: int, total: int): ScopeNode {
  let n: ScopeNode = { path: path, documents: documents, total: total };
  return n;
}

test("no folders is an empty list, not an empty string", () => {
  let none: ScopeNode[] = [];
  expect(scopesJson(none) == "[]");
});

test("a folder carries its own count and its subtree's", () => {
  let one: ScopeNode[] = [node("/specs", 3, 11)];
  expect(scopesJson(one) == "[{\"path\":\"/specs\",\"documents\":3,\"total\":11}]");
});

test("folders are separated, and a quote in a path does not break the document", () => {
  let two: ScopeNode[] = [node("/a", 1, 1), node("/b\"c", 0, 2)];
  let out = scopesJson(two);
  expect(out.indexOf("},{") >= 0);
  expect(out.indexOf("\\\"") >= 0);
});
