// plume against a live database. The mapping, the round trip, projections and
// projections are the parts worth knowing are real, and none survive a mock:
// the database is half of the mapper.
//
//   sh packages/plume/build.sh
//   createdb lumenvec
//   cd packages/plume && lumen test plume.test.ts
//
// Override the connection with PLUME_TEST_CONNINFO.

import { DbField, DbRepository, connectDatabase, databaseConnected, closeDatabase, field, repository, repositoryValid, safeIdentifier, safeSqlType, placeholderAt, selectList, createTable, dropTable, persist, persistMany, findById, findProjected, listWhere, listProjected, pageWhere, countWhere, existsById, deleteById, deleteWhere, beginTransaction, commitTransaction, rollbackTransaction, execute, pickFields, jsonMember } from "./plume.ts";
import { Db, DbConfig } from "./driver.ts";
import { postgres, postgresConnection, postgresVersion } from "./postgres.ts";

// One driver for the whole suite. The name avoids `db`, which every plume
// operation uses as a parameter name.
let database: Db = postgres();

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

function testConfig(): DbConfig {
  // An env override arrives as a libpq conninfo string; `options` takes it
  // whole, which is the escape hatch a config keeps for a target the fields
  // cannot describe.
  let fromEnv = process.env("PLUME_TEST_CONNINFO") ?? "";
  if (fromEnv != "") { let raw: DbConfig = { options: fromEnv }; return raw; }
  let named: DbConfig = { host: "127.0.0.1", database: "lumenvec", user: "lumen", password: "lumen" };
  return named;
}

function agentRepo(): DbRepository {
  let fields: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
    field("temperature", "temperature", "float8"),
  ];
  return repository({ table: "plume_test_agents", idField: "id", idColumn: "id", fields: fields });
}

function agentJson(id: string, name: string, steps: int, temp: number): string {
  let a: Agent = { id: id, agentName: name, maxSteps: steps, temperature: temp };
  return JSON.stringify(a);
}

function fresh(): DbRepository {
  connectDatabase(database, testConfig());
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
  expect(repositoryValid(repository({ table: "t", idField: "id", idColumn: "id", fields: good })));
  // idField names a field the mapping does not declare.
  expect(!repositoryValid(repository({ table: "t", idField: "missing", idColumn: "id", fields: good })));
  let empty: DbField[] = [];
  expect(!repositoryValid(repository({ table: "t", idField: "id", idColumn: "id", fields: empty })));
});

test("the select list renames columns to fields", () => {
  let list = selectList(agentRepo());
  expect(list.indexOf("agent_name AS \"agentName\"") >= 0);
  expect(list.indexOf("max_steps AS \"maxSteps\"") >= 0);
});

// --- connection and schema ----------------------------------------------------------

test("a connection opens", () => {
  let r = connectDatabase(database, testConfig());
  expect(r.ok);
  expect(databaseConnected(database));
  expect(postgresVersion().length > 0);
});

test("a bad connection is reported, not raised", () => {
  let nowhere: DbConfig = { host: "127.0.0.1", port: 1, user: "nobody", database: "nope" };
  let r = connectDatabase(database, nowhere);
  expect(!r.ok);
  expect(r.error.length > 0);
  expect(connectDatabase(database, testConfig()).ok);
});

test("a table is created from the mapping and dropped", () => {
  connectDatabase(database, testConfig());
  let repo = agentRepo();
  expect(dropTable(database, repo).ok);
  expect(createTable(database, repo).ok);
  expect(countWhere(database, repo, "", []) == 0);
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
  expect(countWhere(database, repo, "", []) == 1);
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
  expect(countWhere(database, repo, "", []) == 2);
  expect(persistMany(database, repo, "[]").ok);
});

test("text containing a quote is data, not syntax", () => {
  let repo = fresh();
  let nasty = "it's a test'); DROP TABLE plume_test_agents; --";
  expect(persist(database, repo, agentJson("q", nasty, 1, 0.0)).ok);
  let back: Agent = JSON.parse<Agent>(findById(database, repo, "q"));
  expect(back.agentName == nasty);
  // The table is still there, which it would not be if the text had been pasted in.
  expect(countWhere(database, repo, "", []) == 1);
});

// --- querying -------------------------------------------------------------------------

test("a list comes back as a JSON array of mapped records", () => {
  let repo = seeded();
  let all = listWhere(database, repo, "", []);
  expect(all.indexOf("agentName") >= 0);
  expect(all.indexOf("researcher") >= 0);
  expect(all.indexOf("writer") >= 0);
});

test("a where clause binds its parameter", () => {
  let repo = seeded();
  let some = listWhere(database, repo, "agent_name = " + database.placeholder, ["writer"]);
  expect(some.indexOf("writer") >= 0);
  expect(some.indexOf("researcher") < 0);
});

test("an empty result is an empty array, not nothing", () => {
  let repo = seeded();
  expect(listWhere(database, repo, "agent_name = " + database.placeholder, ["absent"]) == "[]");
});

test("counting honours the filter", () => {
  let repo = seeded();
  expect(countWhere(database, repo, "", []) == 3);
  expect(countWhere(database, repo, "max_steps > " + database.placeholder, ["4"]) == 2);
  expect(countWhere(database, repo, "agent_name = " + database.placeholder, ["absent"]) == 0);
});

test("a page is ordered and bounded", () => {
  let repo = seeded();
  let first = pageWhere(database, repo, { orderBy: "max_steps", limit: 1, offset: 0 });
  let second = pageWhere(database, repo, { orderBy: "max_steps", limit: 1, offset: 1 });
  // Ordered by max_steps: critic 8 is last, writer 3 first.
  expect(first.indexOf("writer") >= 0);
  expect(second.indexOf("researcher") >= 0);
  expect(first.indexOf("critic") < 0);
});

test("an unsafe order column is refused", () => {
  let repo = seeded();
  expect(pageWhere(database, repo, { orderBy: "x; DROP TABLE plume_test_agents", limit: 10, offset: 0 }) == "[]");
  expect(countWhere(database, repo, "", []) == 3);
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
  let json = listProjected(database, repo, "id AS \"id\", agent_name AS \"agentName\"", "", []);
  expect(json.indexOf("maxSteps") < 0);
  expect(json.indexOf("agentName") >= 0);
});

test("a double keeps every digit it went in with", () => {
  // SQLite renders a REAL to text at 15 significant digits, so this value came
  // back as 1234567890.12346 — a mapper quietly altering a number is worse
  // than one that refuses.
  let repo = fresh();
  let precise = 1234567890.123456;
  persist(database, repo, agentJson("a1", "researcher", 5, precise));
  let back: Agent = JSON.parse<Agent>(findById(database, repo, "a1"));
  expect(back.temperature == precise);
});

test("a projection whose expression contains a comma is read correctly", () => {
  // Splitting a select list on every comma broke `coalesce(a, b) AS x` into
  // two nonsense pieces, and a pairs-style driver returned a document keyed
  // "coalesce(agent_name" while PostgreSQL returned the right answer for the
  // identical call. Ordinary SQL, not a hostile input.
  let repo = seeded();
  let cols = "id AS \"id\", coalesce(agent_name, 'none') AS \"agentName\"";
  let json = listProjected(database, repo, cols, "", []);
  expect(json.indexOf("\"agentName\"") >= 0);
  expect(json.indexOf("coalesce") < 0);
  expect(json.indexOf("researcher") >= 0);
});

test("an alias that is not a plain name is refused, not sent", () => {
  // The alias becomes a JSON key between single quotes, so a quote in it would
  // end the literal. Refusing beats repairing.
  let repo = seeded();
  expect(listProjected(database, repo, "agent_name AS \"x',(1)\"", "", []) == "[]");
  expect(findProjected(database, repo, "agent_name AS \"x'\"", "a1") == "");
  // And the table is still there, so nothing was executed.
  expect(countWhere(database, repo, "", []) == 3);
});

test("a select list with an unbalanced quote or paren is refused", () => {
  let repo = seeded();
  expect(listProjected(database, repo, "coalesce(agent_name, 'none' AS \"a\"", "", []) == "[]");
  expect(listProjected(database, repo, "agent_name AS \"a", "", []) == "[]");
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
  expect(countWhere(database, repo, "", []) == 2);
  expect(!existsById(database, repo, "a1"));
});

test("records are deleted by a filter", () => {
  let repo = seeded();
  expect(deleteWhere(database, repo, "max_steps > " + database.placeholder, ["4"]).ok);
  expect(countWhere(database, repo, "", []) == 1);
});

// --- transactions -----------------------------------------------------------------------------

test("a rolled-back write leaves nothing behind", () => {
  let repo = fresh();
  expect(beginTransaction(database).ok);
  persist(database, repo, agentJson("t1", "temp", 1, 0.0));
  expect(countWhere(database, repo, "", []) == 1);
  expect(rollbackTransaction(database).ok);
  expect(countWhere(database, repo, "", []) == 0);
});

test("a committed write stays", () => {
  let repo = fresh();
  expect(beginTransaction(database).ok);
  persist(database, repo, agentJson("t2", "kept", 1, 0.0));
  expect(commitTransaction(database).ok);
  expect(countWhere(database, repo, "", []) == 1);
});


// --- more than one bound value ------------------------------------------------------------------

// The statement a single-parameter driver could not express. The second value
// used to be pasted into the SQL, which is the route the MySQL backslash
// injection came in by.
test("a where clause binds two different values", () => {
  let repo = seeded();
  let where = "agent_name = " + placeholderAt(database, 1)
    + " AND max_steps > " + placeholderAt(database, 2);
  let hit = listWhere(database, repo, where, ["critic", "4"]);
  expect(hit.indexOf("critic") >= 0);
  expect(hit.indexOf("writer") < 0);
  expect(hit.indexOf("researcher") < 0);
  // A second value the rows do not satisfy matches nothing, which is what
  // shows it is read rather than ignored.
  expect(listWhere(database, repo, where, ["critic", "9"]) == "[]");
  expect(countWhere(database, repo, where, ["researcher", "4"]) == 1);
  expect(countWhere(database, repo, where, ["researcher", "5"]) == 0);
});

test("a bound value carrying a quote, a backslash and a newline survives", () => {
  let repo = fresh();
  let nasty = "it's a \\ backslash\nand a newline";
  expect(persist(database, repo, agentJson("n1", nasty, 7, 0.5)).ok);
  let back: Agent = JSON.parse<Agent>(findById(database, repo, "n1"));
  expect(back.agentName == nasty);
  // And it matches itself when bound into a where clause, so it went in and
  // came back as the same bytes rather than as something the escaper mangled.
  expect(countWhere(database, repo, "agent_name = " + placeholderAt(database, 1), [nasty]) == 1);
  // The table is still there, which it would not be had the text become SQL.
  expect(countWhere(database, repo, "", []) == 1);
});

// --- connections of their own -------------------------------------------------------------------

test("two connections each hold their own rows", () => {
  let repo = seeded();
  let writer = postgresConnection(testConfig());
  let reader = postgresConnection(testConfig());
  expect(writer.connected());
  expect(reader.connected());

  // Written through one and read through the other: two connections to one
  // database, not one connection behind two records.
  expect(persist(writer, repo, agentJson("c1", "handled", 6, 0.4)).ok);

  expect(reader.query("SELECT agent_name FROM " + repo.table + " ORDER BY agent_name", []));
  expect(reader.rows() == 4);
  expect(reader.value(0, 0) == "critic");

  // A query on the other connection, between two reads of this one. A result
  // set held per shim rather than per connection is what this would clobber.
  expect(writer.query("SELECT count(*) FROM " + repo.table, []));
  expect(writer.value(0, 0) == "4");

  expect(reader.rows() == 4);
  expect(reader.value(0, 0) == "critic");
  expect(reader.value(3, 0) == "writer");

  writer.close();
  reader.close();
  // Releasing a slot leaves the process-wide connection alone.
  expect(databaseConnected(database));
  expect(countWhere(database, repo, "", []) == 4);
});

// --- configuration ------------------------------------------------------------------------------

test("a config naming nothing to reach is refused, not attempted", () => {
  let nothing: DbConfig = { user: "lumen" };
  let spare = postgresConnection(nothing);
  expect(!spare.connected());
  expect(spare.lastError().length > 0);
  spare.close();
});

test("a failed connection does not put the password in its diagnostic", () => {
  // Named outright rather than through the suite's config: this is about what
  // the driver renders, and PLUME_TEST_CONNINFO would supply a raw target with
  // nothing to override.
  let wrong: DbConfig = { host: "127.0.0.1", database: "lumenvec", user: "lumen", password: "hunter2 swordfish" };
  let spare = postgresConnection(wrong);
  expect(!spare.connected());
  let why = spare.lastError();
  expect(why.length > 0);
  expect(why.indexOf("hunter2") < 0);
  expect(why.indexOf("swordfish") < 0);
  spare.close();
});

test("a config value carrying a space is quoted, not truncated", () => {
  // The database does not exist, so the connection fails — and it fails naming
  // the whole value. Truncated at the space it would have complained about a
  // database called "plume", and the rest of the list would have been read as
  // further keys.
  let spaced: DbConfig = { host: "127.0.0.1", database: "plume no such db", user: "lumen", password: "lumen" };
  let spare = postgresConnection(spaced);
  expect(!spare.connected());
  expect(spare.lastError().indexOf("plume no such db") >= 0);
  spare.close();
});

test("the suite leaves nothing behind", () => {
  connectDatabase(database, testConfig());
  dropTable(database, agentRepo());
    closeDatabase(database);
  expect(true);
});
