// The same suite as plume.test.ts, against SQLite instead of PostgreSQL.
//
// Every assertion here is a copy of the PostgreSQL one, deliberately: the
// point of the driver split is that the same mapping and the same operations
// produce the same answers on both, and only a duplicated suite proves that.
// What differs is the connection target and nothing else.
//
//   sh packages/plume/build.sh
//   cd packages/plume && lumen test sqlite.test.ts

import { connectDatabase, databaseConnected, closeDatabase, field, repository, repositoryValid, safeIdentifier, safeSqlType, selectList, createTable, dropTable, persist, persistMany, findById, findProjected, listWhere, listProjected, pageWhere, countWhere, existsById, deleteById, deleteWhere, beginTransaction, commitTransaction, rollbackTransaction, execute, pickFields, jsonMember } from "./plume.ts";
import { Db } from "./driver.ts";
import { sqlite, sqliteVersion } from "./sqlite.ts";

// One driver for the whole suite. The name avoids `db`, which every plume
// operation uses as a parameter name.
let database: Db = sqlite();

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

// A file rather than ":memory:", so a reconnect in the bad-target test does
// not silently discard the schema.
function testConninfo(): string {
  return "/tmp/plume_sqlite_test.db";
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
  connectDatabase(database, testConninfo());
  let repo = agentRepo();
  dropTable(database, repo);
  createTable(database, repo);
  return repo;
}

function seeded(): DbRepository {
  let repo = fresh();
  persist(database, repo, agentJson("a1", "researcher", 5, 0.2));
  persist(database, repo, agentJson("a2", "writer", 3, 0.7));
  persist(database, repo, agentJson("a3", "critic", 8, 0.1));
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
  let r = connectDatabase(database, testConninfo());
  expect(r.ok);
  expect(databaseConnected(database));
  expect(sqliteVersion().length > 0);
});

test("a bad connection is reported, not raised", () => {
  let r = connectDatabase(database, "/nonexistent-directory/nope.db");
  expect(!r.ok);
  expect(r.error.length > 0);
  expect(connectDatabase(database, testConninfo()).ok);
});

test("a table is created from the mapping and dropped", () => {
  connectDatabase(database, testConninfo());
  let repo = agentRepo();
  expect(dropTable(database, repo).ok);
  expect(createTable(database, repo).ok);
  expect(countWhere(database, repo, "", "") == 0);
  // Creating twice is not an error.
  expect(createTable(database, repo).ok);
  expect(dropTable(database, repo).ok);
});

// A where clause is the caller's own SQL, so its placeholder is the driver's:
// `$1` on PostgreSQL, `?` on the others. Writing it as database.placeholder is
// what makes the same test run against all three.

// --- the round trip -------------------------------------------------------------------

test("a record survives the round trip through its columns", () => {
  let repo = fresh();
  expect(persist(database, repo, agentJson("a1", "researcher", 5, 0.2)).ok);
  let json = findById(database, repo, "a1");
  expect(json != "");
  let back: Agent = JSON.parse<Agent>(json);
  expect(back.id == "a1");
  expect(back.agentName == "researcher");
  expect(back.maxSteps == 5);
  expect(back.temperature == 0.2);
});

test("the mapping really renames: the column is snake, the field is camel", () => {
  let repo = fresh();
  persist(database, repo, agentJson("a1", "researcher", 5, 0.2));
  // Read the raw column, bypassing the mapping.
  execute(database, "SELECT 1");
  let raw = findProjected(database, repo, "agent_name", "a1");
  expect(raw.indexOf("agent_name") >= 0);
  // Through the mapping it is agentName.
  expect(findById(database, repo, "a1").indexOf("agentName") >= 0);
});

test("persisting the same key replaces rather than duplicates", () => {
  let repo = fresh();
  persist(database, repo, agentJson("a1", "researcher", 5, 0.2));
  expect(persist(database, repo, agentJson("a1", "renamed", 9, 0.9)).ok);
  expect(countWhere(database, repo, "", "") == 1);
  let back: Agent = JSON.parse<Agent>(findById(database, repo, "a1"));
  expect(back.agentName == "renamed");
  expect(back.maxSteps == 9);
});

test("a missing record reads as empty", () => {
  let repo = fresh();
  expect(findById(database, repo, "nope") == "");
  expect(!existsById(database, repo, "nope"));
});

test("many records persist in one statement", () => {
  let repo = fresh();
  let batch = "[" + agentJson("b1", "one", 1, 0.1) + "," + agentJson("b2", "two", 2, 0.2) + "]";
  expect(persistMany(database, repo, batch).ok);
  expect(countWhere(database, repo, "", "") == 2);
  expect(persistMany(database, repo, "[]").ok);
});

test("text containing a quote is data, not syntax", () => {
  let repo = fresh();
  let nasty = "it's a test'); DROP TABLE plume_test_agents; --";
  expect(persist(database, repo, agentJson("q", nasty, 1, 0.0)).ok);
  let back: Agent = JSON.parse<Agent>(findById(database, repo, "q"));
  expect(back.agentName == nasty);
  // The table is still there, which it would not be if the text had been pasted in.
  expect(countWhere(database, repo, "", "") == 1);
});

// --- querying -------------------------------------------------------------------------

test("a list comes back as a JSON array of mapped records", () => {
  let repo = seeded();
  let all = listWhere(database, repo, "", "");
  expect(all.indexOf("agentName") >= 0);
  expect(all.indexOf("researcher") >= 0);
  expect(all.indexOf("writer") >= 0);
});

test("a where clause binds its parameter", () => {
  let repo = seeded();
  let some = listWhere(database, repo, "agent_name = " + database.placeholder, "writer");
  expect(some.indexOf("writer") >= 0);
  expect(some.indexOf("researcher") < 0);
});

test("an empty result is an empty array, not nothing", () => {
  let repo = seeded();
  expect(listWhere(database, repo, "agent_name = " + database.placeholder, "absent") == "[]");
});

test("counting honours the filter", () => {
  let repo = seeded();
  expect(countWhere(database, repo, "", "") == 3);
  expect(countWhere(database, repo, "max_steps > " + database.placeholder, "4") == 2);
  expect(countWhere(database, repo, "agent_name = " + database.placeholder, "absent") == 0);
});

test("a page is ordered and bounded", () => {
  let repo = seeded();
  let first = pageWhere(database, repo, "", "", "max_steps", 1, 0);
  let second = pageWhere(database, repo, "", "", "max_steps", 1, 1);
  // Ordered by max_steps: critic 8 is last, writer 3 first.
  expect(first.indexOf("writer") >= 0);
  expect(second.indexOf("researcher") >= 0);
  expect(first.indexOf("critic") < 0);
});

test("an unsafe order column is refused", () => {
  let repo = seeded();
  expect(pageWhere(database, repo, "", "", "x; DROP TABLE plume_test_agents", 10, 0) == "[]");
  expect(countWhere(database, repo, "", "") == 3);
});

// --- projections, the mapper -----------------------------------------------------------------

test("a projection narrows a record into a DTO", () => {
  let repo = seeded();
  // JSON.parse rejects extra fields, so the projection is what makes this work.
  let json = findProjected(database, repo, "id AS \"id\", agent_name AS \"agentName\"", "a1");
  let dto: AgentSummary = JSON.parse<AgentSummary>(json);
  expect(dto.id == "a1");
  expect(dto.agentName == "researcher");
});

test("a projected list narrows every row", () => {
  let repo = seeded();
  let json = listProjected(database, repo, "id AS \"id\", agent_name AS \"agentName\"", "", "");
  expect(json.indexOf("maxSteps") < 0);
  expect(json.indexOf("agentName") >= 0);
});

test("a projection whose expression contains a comma is read correctly", () => {
  // Splitting a select list on every comma broke `coalesce(a, b) AS x` into
  // two nonsense pieces, and a pairs-style driver returned a document keyed
  // "coalesce(agent_name" while PostgreSQL returned the right answer for the
  // identical call. Ordinary SQL, not a hostile input.
  let repo = seeded();
  let cols = "id AS \"id\", coalesce(agent_name, 'none') AS \"agentName\"";
  let json = listProjected(database, repo, cols, "", "");
  expect(json.indexOf("\"agentName\"") >= 0);
  expect(json.indexOf("coalesce") < 0);
  expect(json.indexOf("researcher") >= 0);
});

test("an alias that is not a plain name is refused, not sent", () => {
  // The alias becomes a JSON key between single quotes, so a quote in it would
  // end the literal. Refusing beats repairing.
  let repo = seeded();
  expect(listProjected(database, repo, "agent_name AS \"x',(1)\"", "", "") == "[]");
  expect(findProjected(database, repo, "agent_name AS \"x'\"", "a1") == "");
  // And the table is still there, so nothing was executed.
  expect(countWhere(database, repo, "", "") == 3);
});

test("a select list with an unbalanced quote or paren is refused", () => {
  let repo = seeded();
  expect(listProjected(database, repo, "coalesce(agent_name, 'none' AS \"a\"", "", "") == "[]");
  expect(listProjected(database, repo, "agent_name AS \"a", "", "") == "[]");
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
  expect(deleteById(database, repo, "a1").ok);
  expect(countWhere(database, repo, "", "") == 2);
  expect(!existsById(database, repo, "a1"));
});

test("records are deleted by a filter", () => {
  let repo = seeded();
  expect(deleteWhere(database, repo, "max_steps > " + database.placeholder, "4").ok);
  expect(countWhere(database, repo, "", "") == 1);
});

// --- transactions -----------------------------------------------------------------------------

test("a rolled-back write leaves nothing behind", () => {
  let repo = fresh();
  expect(beginTransaction(database).ok);
  persist(database, repo, agentJson("t1", "temp", 1, 0.0));
  expect(countWhere(database, repo, "", "") == 1);
  expect(rollbackTransaction(database).ok);
  expect(countWhere(database, repo, "", "") == 0);
});

test("a committed write stays", () => {
  let repo = fresh();
  expect(beginTransaction(database).ok);
  persist(database, repo, agentJson("t2", "kept", 1, 0.0));
  expect(commitTransaction(database).ok);
  expect(countWhere(database, repo, "", "") == 1);
});

test("the suite leaves nothing behind", () => {
  connectDatabase(database, testConninfo());
  dropTable(database, agentRepo());
    closeDatabase(database);
  expect(true);
});
