// plume against a live database. The mapping, the round trip, projections and
// migrations are the parts worth knowing are real, and none survive a mock:
// the database is half of the mapper.
//
//   sh packages/plume/build.sh
//   createdb lumenvec
//   cd packages/plume && lumen test plume.test.ts
//
// Override the connection with PLUME_TEST_CONNINFO.

import { connectDatabase, databaseConnected, closeDatabase, databaseVersion, field, repository, repositoryValid, safeIdentifier, safeSqlType, selectList, createTable, dropTable, persist, persistMany, findById, findProjected, listWhere, listProjected, pageWhere, countWhere, existsById, deleteById, deleteWhere, beginTransaction, commitTransaction, rollbackTransaction, migrate, migrationApplied, execute, pickFields, jsonMember } from "./plume.ts";

// A record whose field names deliberately disagree with its columns, so every
// test exercises the mapping rather than a coincidence.
type Agent = {
  id: string,
  agentName: string,
  maxSteps: int,
  temperature: number,
};

type AgentSummary = {
  id: string,
  agentName: string,
};

function testConninfo(): string {
  let fromEnv = process.env("PLUME_TEST_CONNINFO") ?? "";
  if (fromEnv != "") { return fromEnv; }
  return "host=127.0.0.1 user=lumen password=lumen dbname=lumenvec";
}

function agentRepo(): DbRepository {
  let fields: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
    field("temperature", "temperature", "float8"),
  ];
  return repository("plume_test_agents", "id", "id", fields);
}

function agentJson(id: string, name: string, steps: int, temp: number): string {
  let a: Agent = { id: id, agentName: name, maxSteps: steps, temperature: temp };
  return JSON.stringify(a);
}

function fresh(): DbRepository {
  connectDatabase(testConninfo());
  let repo = agentRepo();
  dropTable(repo);
  createTable(repo);
  return repo;
}

function seeded(): DbRepository {
  let repo = fresh();
  persist(repo, agentJson("a1", "researcher", 5, 0.2));
  persist(repo, agentJson("a2", "writer", 3, 0.7));
  persist(repo, agentJson("a3", "critic", 8, 0.1));
  return repo;
}

// --- names and mappings, offline -------------------------------------------------

test("an identifier must be a plain name", () => {
  expect(safeIdentifier("agents"));
  expect(safeIdentifier("agent_name"));
  expect(!safeIdentifier("agents; DROP TABLE x"));
  expect(!safeIdentifier("a-b"));
  expect(!safeIdentifier("1abc"));
  expect(!safeIdentifier(""));
});

test("a type may carry spaces and parentheses", () => {
  expect(safeSqlType("text"));
  expect(safeSqlType("timestamp with time zone"));
  expect(safeSqlType("numeric(10,2)"));
  expect(!safeSqlType("text; DROP TABLE x"));
});

test("a mapping must name its key field", () => {
  let good: DbField[] = [field("id", "id", "text"), field("n", "n", "text")];
  expect(repositoryValid(repository("t", "id", "id", good)));
  // idField names a field the mapping does not declare.
  expect(!repositoryValid(repository("t", "missing", "id", good)));
  let empty: DbField[] = [];
  expect(!repositoryValid(repository("t", "id", "id", empty)));
});

test("the select list renames columns to fields", () => {
  let list = selectList(agentRepo());
  expect(list.indexOf("agent_name AS \"agentName\"") >= 0);
  expect(list.indexOf("max_steps AS \"maxSteps\"") >= 0);
});

// --- connection and schema ----------------------------------------------------------

test("a connection opens", () => {
  let r = connectDatabase(testConninfo());
  expect(r.ok);
  expect(databaseConnected());
  expect(databaseVersion() > 0);
});

test("a bad connection is reported, not raised", () => {
  let r = connectDatabase("host=127.0.0.1 port=1 dbname=nope user=nobody");
  expect(!r.ok);
  expect(r.error.length > 0);
  expect(connectDatabase(testConninfo()).ok);
});

test("a table is created from the mapping and dropped", () => {
  connectDatabase(testConninfo());
  let repo = agentRepo();
  expect(dropTable(repo).ok);
  expect(createTable(repo).ok);
  expect(countWhere(repo, "", "") == 0);
  // Creating twice is not an error.
  expect(createTable(repo).ok);
  expect(dropTable(repo).ok);
});

// --- the round trip -------------------------------------------------------------------

test("a record survives the round trip through its columns", () => {
  let repo = fresh();
  expect(persist(repo, agentJson("a1", "researcher", 5, 0.2)).ok);
  let json = findById(repo, "a1");
  expect(json != "");
  let back: Agent = JSON.parse<Agent>(json);
  expect(back.id == "a1");
  expect(back.agentName == "researcher");
  expect(back.maxSteps == 5);
  expect(back.temperature == 0.2);
});

test("the mapping really renames: the column is snake, the field is camel", () => {
  let repo = fresh();
  persist(repo, agentJson("a1", "researcher", 5, 0.2));
  // Read the raw column, bypassing the mapping.
  execute("SELECT 1");
  let raw = findProjected(repo, "agent_name", "a1");
  expect(raw.indexOf("agent_name") >= 0);
  // Through the mapping it is agentName.
  expect(findById(repo, "a1").indexOf("agentName") >= 0);
});

test("persisting the same key replaces rather than duplicates", () => {
  let repo = fresh();
  persist(repo, agentJson("a1", "researcher", 5, 0.2));
  expect(persist(repo, agentJson("a1", "renamed", 9, 0.9)).ok);
  expect(countWhere(repo, "", "") == 1);
  let back: Agent = JSON.parse<Agent>(findById(repo, "a1"));
  expect(back.agentName == "renamed");
  expect(back.maxSteps == 9);
});

test("a missing record reads as empty", () => {
  let repo = fresh();
  expect(findById(repo, "nope") == "");
  expect(!existsById(repo, "nope"));
});

test("many records persist in one statement", () => {
  let repo = fresh();
  let batch = "[" + agentJson("b1", "one", 1, 0.1) + "," + agentJson("b2", "two", 2, 0.2) + "]";
  expect(persistMany(repo, batch).ok);
  expect(countWhere(repo, "", "") == 2);
  expect(persistMany(repo, "[]").ok);
});

test("text containing a quote is data, not syntax", () => {
  let repo = fresh();
  let nasty = "it's a test'); DROP TABLE plume_test_agents; --";
  expect(persist(repo, agentJson("q", nasty, 1, 0.0)).ok);
  let back: Agent = JSON.parse<Agent>(findById(repo, "q"));
  expect(back.agentName == nasty);
  // The table is still there, which it would not be if the text had been pasted in.
  expect(countWhere(repo, "", "") == 1);
});

// --- querying -------------------------------------------------------------------------

test("a list comes back as a JSON array of mapped records", () => {
  let repo = seeded();
  let all = listWhere(repo, "", "");
  expect(all.indexOf("agentName") >= 0);
  expect(all.indexOf("researcher") >= 0);
  expect(all.indexOf("writer") >= 0);
});

test("a where clause binds its parameter", () => {
  let repo = seeded();
  let some = listWhere(repo, "agent_name = $1", "writer");
  expect(some.indexOf("writer") >= 0);
  expect(some.indexOf("researcher") < 0);
});

test("an empty result is an empty array, not nothing", () => {
  let repo = seeded();
  expect(listWhere(repo, "agent_name = $1", "absent") == "[]");
});

test("counting honours the filter", () => {
  let repo = seeded();
  expect(countWhere(repo, "", "") == 3);
  expect(countWhere(repo, "max_steps > $1", "4") == 2);
  expect(countWhere(repo, "agent_name = $1", "absent") == 0);
});

test("a page is ordered and bounded", () => {
  let repo = seeded();
  let first = pageWhere(repo, "", "", "max_steps", 1, 0);
  let second = pageWhere(repo, "", "", "max_steps", 1, 1);
  // Ordered by max_steps: critic 8 is last, writer 3 first.
  expect(first.indexOf("writer") >= 0);
  expect(second.indexOf("researcher") >= 0);
  expect(first.indexOf("critic") < 0);
});

test("an unsafe order column is refused", () => {
  let repo = seeded();
  expect(pageWhere(repo, "", "", "x; DROP TABLE plume_test_agents", 10, 0) == "[]");
  expect(countWhere(repo, "", "") == 3);
});

// --- projections, the mapper -----------------------------------------------------------------

test("a projection narrows a record into a DTO", () => {
  let repo = seeded();
  // JSON.parse rejects extra fields, so the projection is what makes this work.
  let json = findProjected(repo, "id AS \"id\", agent_name AS \"agentName\"", "a1");
  let dto: AgentSummary = JSON.parse<AgentSummary>(json);
  expect(dto.id == "a1");
  expect(dto.agentName == "researcher");
});

test("a projected list narrows every row", () => {
  let repo = seeded();
  let json = listProjected(repo, "id AS \"id\", agent_name AS \"agentName\"", "", "");
  expect(json.indexOf("maxSteps") < 0);
  expect(json.indexOf("agentName") >= 0);
});

test("picking narrows a document in memory", () => {
  let full = agentJson("a1", "researcher", 5, 0.2);
  let keys: string[] = ["id", "agentName"];
  let narrowed = pickFields(full, keys);
  let dto: AgentSummary = JSON.parse<AgentSummary>(narrowed);
  expect(dto.id == "a1");
  expect(dto.agentName == "researcher");
});

test("picking keeps a value containing braces intact", () => {
  let doc = "{\"id\":\"a1\",\"note\":\"{not an object}\",\"n\":2}";
  let keys: string[] = ["id", "note"];
  let out = pickFields(doc, keys);
  expect(out.indexOf("{not an object}") >= 0);
  expect(out.indexOf("\"n\"") < 0);
});

test("a member reads whole values of every kind", () => {
  let doc = "{\"s\":\"text\",\"n\":42,\"f\":0.5,\"b\":true,\"o\":{\"k\":1},\"a\":[1,2]}";
  expect(jsonMember(doc, "s") == "\"text\"");
  expect(jsonMember(doc, "n") == "42");
  expect(jsonMember(doc, "b") == "true");
  expect(jsonMember(doc, "o") == "{\"k\":1}");
  expect(jsonMember(doc, "a") == "[1,2]");
  expect(jsonMember(doc, "absent") == "");
});

test("a nested key of the same name is not mistaken for a top-level one", () => {
  let doc = "{\"inner\":{\"id\":\"wrong\"},\"id\":\"right\"}";
  expect(jsonMember(doc, "id") == "\"right\"");
});

// --- deleting ----------------------------------------------------------------------------------

test("a record is deleted by key", () => {
  let repo = seeded();
  expect(deleteById(repo, "a1").ok);
  expect(countWhere(repo, "", "") == 2);
  expect(!existsById(repo, "a1"));
});

test("records are deleted by a filter", () => {
  let repo = seeded();
  expect(deleteWhere(repo, "max_steps > $1", "4").ok);
  expect(countWhere(repo, "", "") == 1);
});

// --- transactions -----------------------------------------------------------------------------

test("a rolled-back write leaves nothing behind", () => {
  let repo = fresh();
  expect(beginTransaction().ok);
  persist(repo, agentJson("t1", "temp", 1, 0.0));
  expect(countWhere(repo, "", "") == 1);
  expect(rollbackTransaction().ok);
  expect(countWhere(repo, "", "") == 0);
});

test("a committed write stays", () => {
  let repo = fresh();
  expect(beginTransaction().ok);
  persist(repo, agentJson("t2", "kept", 1, 0.0));
  expect(commitTransaction().ok);
  expect(countWhere(repo, "", "") == 1);
});

// --- migrations --------------------------------------------------------------------------------

test("migrations apply once and are recorded", () => {
  connectDatabase(testConninfo());
  execute("DROP TABLE IF EXISTS plume_migrations");
  execute("DROP TABLE IF EXISTS plume_mig_demo");
  let names: string[] = ["V1__create", "V2__add_column"];
  let statements: string[] = [
    "CREATE TABLE plume_mig_demo (id text PRIMARY KEY)",
    "ALTER TABLE plume_mig_demo ADD COLUMN note text",
  ];
  let first = migrate(names, statements);
  expect(first.ok);
  expect(first.rows == 2);
  expect(migrationApplied("V1__create"));
  // A second run applies nothing.
  let second = migrate(names, statements);
  expect(second.ok);
  expect(second.rows == 0);
  execute("DROP TABLE IF EXISTS plume_mig_demo");
});

test("a failing migration reports which one and stops", () => {
  connectDatabase(testConninfo());
  execute("DROP TABLE IF EXISTS plume_migrations");
  let names: string[] = ["V1__ok", "V2__broken"];
  let statements: string[] = [
    "CREATE TABLE IF NOT EXISTS plume_mig_ok (id text)",
    "THIS IS NOT SQL",
  ];
  let r = migrate(names, statements);
  expect(!r.ok);
  expect(r.error.indexOf("V2__broken") >= 0);
  // The one before it stuck.
  expect(migrationApplied("V1__ok"));
  execute("DROP TABLE IF EXISTS plume_mig_ok");
  execute("DROP TABLE IF EXISTS plume_migrations");
});

test("a mismatched migration list is refused", () => {
  connectDatabase(testConninfo());
  let names: string[] = ["only-one"];
  let statements: string[] = ["SELECT 1", "SELECT 2"];
  let r = migrate(names, statements);
  expect(!r.ok);
  expect(r.error.indexOf("every migration needs a name") >= 0);
});

test("the suite leaves nothing behind", () => {
  connectDatabase(testConninfo());
  dropTable(agentRepo());
  execute("DROP TABLE IF EXISTS plume_migrations");
  closeDatabase();
  expect(true);
});
