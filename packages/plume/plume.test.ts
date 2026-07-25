// plume against a live database. The mapping, the round trip, projections and
// migrations are the parts worth knowing are real, and none survive a mock:
// the database is half of the mapper.
//
//   sh packages/plume/build.sh
//   createdb lumenvec
//   cd packages/plume && lumen test plume.test.ts
//
// Override the connection with PLUME_TEST_CONNINFO.

import { plConnect, plConnected, plClose, plServerVersion, plField, plRepo, plRepoValid, plSafeName, plSafeType, plSelectList, plCreateTable, plDropTable, plPersist, plPersistMany, plFind, plFindAs, plList, plListAs, plPage, plCount, plExists, plDelete, plDeleteWhere, plBegin, plCommit, plRollback, plMigrate, plMigrationApplied, plExec, plPick, plMember } from "./plume.ts";

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

function agentRepo(): PlRepo {
  let fields: PlField[] = [
    plField("id", "id", "text"),
    plField("agentName", "agent_name", "text"),
    plField("maxSteps", "max_steps", "int"),
    plField("temperature", "temperature", "float8"),
  ];
  return plRepo("plume_test_agents", "id", "id", fields);
}

function agentJson(id: string, name: string, steps: int, temp: number): string {
  let a: Agent = { id: id, agentName: name, maxSteps: steps, temperature: temp };
  return JSON.stringify(a);
}

function fresh(): PlRepo {
  plConnect(testConninfo());
  let repo = agentRepo();
  plDropTable(repo);
  plCreateTable(repo);
  return repo;
}

function seeded(): PlRepo {
  let repo = fresh();
  plPersist(repo, agentJson("a1", "researcher", 5, 0.2));
  plPersist(repo, agentJson("a2", "writer", 3, 0.7));
  plPersist(repo, agentJson("a3", "critic", 8, 0.1));
  return repo;
}

// --- names and mappings, offline -------------------------------------------------

test("an identifier must be a plain name", () => {
  expect(plSafeName("agents"));
  expect(plSafeName("agent_name"));
  expect(!plSafeName("agents; DROP TABLE x"));
  expect(!plSafeName("a-b"));
  expect(!plSafeName("1abc"));
  expect(!plSafeName(""));
});

test("a type may carry spaces and parentheses", () => {
  expect(plSafeType("text"));
  expect(plSafeType("timestamp with time zone"));
  expect(plSafeType("numeric(10,2)"));
  expect(!plSafeType("text; DROP TABLE x"));
});

test("a mapping must name its key field", () => {
  let good: PlField[] = [plField("id", "id", "text"), plField("n", "n", "text")];
  expect(plRepoValid(plRepo("t", "id", "id", good)));
  // idField names a field the mapping does not declare.
  expect(!plRepoValid(plRepo("t", "missing", "id", good)));
  let empty: PlField[] = [];
  expect(!plRepoValid(plRepo("t", "id", "id", empty)));
});

test("the select list renames columns to fields", () => {
  let list = plSelectList(agentRepo());
  expect(list.indexOf("agent_name AS \"agentName\"") >= 0);
  expect(list.indexOf("max_steps AS \"maxSteps\"") >= 0);
});

// --- connection and schema ----------------------------------------------------------

test("a connection opens", () => {
  let r = plConnect(testConninfo());
  expect(r.ok);
  expect(plConnected());
  expect(plServerVersion() > 0);
});

test("a bad connection is reported, not raised", () => {
  let r = plConnect("host=127.0.0.1 port=1 dbname=nope user=nobody");
  expect(!r.ok);
  expect(r.error.length > 0);
  expect(plConnect(testConninfo()).ok);
});

test("a table is created from the mapping and dropped", () => {
  plConnect(testConninfo());
  let repo = agentRepo();
  expect(plDropTable(repo).ok);
  expect(plCreateTable(repo).ok);
  expect(plCount(repo, "", "") == 0);
  // Creating twice is not an error.
  expect(plCreateTable(repo).ok);
  expect(plDropTable(repo).ok);
});

// --- the round trip -------------------------------------------------------------------

test("a record survives the round trip through its columns", () => {
  let repo = fresh();
  expect(plPersist(repo, agentJson("a1", "researcher", 5, 0.2)).ok);
  let json = plFind(repo, "a1");
  expect(json != "");
  let back: Agent = JSON.parse<Agent>(json);
  expect(back.id == "a1");
  expect(back.agentName == "researcher");
  expect(back.maxSteps == 5);
  expect(back.temperature == 0.2);
});

test("the mapping really renames: the column is snake, the field is camel", () => {
  let repo = fresh();
  plPersist(repo, agentJson("a1", "researcher", 5, 0.2));
  // Read the raw column, bypassing the mapping.
  plExec("SELECT 1");
  let raw = plFindAs(repo, "agent_name", "a1");
  expect(raw.indexOf("agent_name") >= 0);
  // Through the mapping it is agentName.
  expect(plFind(repo, "a1").indexOf("agentName") >= 0);
});

test("persisting the same key replaces rather than duplicates", () => {
  let repo = fresh();
  plPersist(repo, agentJson("a1", "researcher", 5, 0.2));
  expect(plPersist(repo, agentJson("a1", "renamed", 9, 0.9)).ok);
  expect(plCount(repo, "", "") == 1);
  let back: Agent = JSON.parse<Agent>(plFind(repo, "a1"));
  expect(back.agentName == "renamed");
  expect(back.maxSteps == 9);
});

test("a missing record reads as empty", () => {
  let repo = fresh();
  expect(plFind(repo, "nope") == "");
  expect(!plExists(repo, "nope"));
});

test("many records persist in one statement", () => {
  let repo = fresh();
  let batch = "[" + agentJson("b1", "one", 1, 0.1) + "," + agentJson("b2", "two", 2, 0.2) + "]";
  expect(plPersistMany(repo, batch).ok);
  expect(plCount(repo, "", "") == 2);
  expect(plPersistMany(repo, "[]").ok);
});

test("text containing a quote is data, not syntax", () => {
  let repo = fresh();
  let nasty = "it's a test'); DROP TABLE plume_test_agents; --";
  expect(plPersist(repo, agentJson("q", nasty, 1, 0.0)).ok);
  let back: Agent = JSON.parse<Agent>(plFind(repo, "q"));
  expect(back.agentName == nasty);
  // The table is still there, which it would not be if the text had been pasted in.
  expect(plCount(repo, "", "") == 1);
});

// --- querying -------------------------------------------------------------------------

test("a list comes back as a JSON array of mapped records", () => {
  let repo = seeded();
  let all = plList(repo, "", "");
  expect(all.indexOf("agentName") >= 0);
  expect(all.indexOf("researcher") >= 0);
  expect(all.indexOf("writer") >= 0);
});

test("a where clause binds its parameter", () => {
  let repo = seeded();
  let some = plList(repo, "agent_name = $1", "writer");
  expect(some.indexOf("writer") >= 0);
  expect(some.indexOf("researcher") < 0);
});

test("an empty result is an empty array, not nothing", () => {
  let repo = seeded();
  expect(plList(repo, "agent_name = $1", "absent") == "[]");
});

test("counting honours the filter", () => {
  let repo = seeded();
  expect(plCount(repo, "", "") == 3);
  expect(plCount(repo, "max_steps > $1", "4") == 2);
  expect(plCount(repo, "agent_name = $1", "absent") == 0);
});

test("a page is ordered and bounded", () => {
  let repo = seeded();
  let first = plPage(repo, "", "", "max_steps", 1, 0);
  let second = plPage(repo, "", "", "max_steps", 1, 1);
  // Ordered by max_steps: critic 8 is last, writer 3 first.
  expect(first.indexOf("writer") >= 0);
  expect(second.indexOf("researcher") >= 0);
  expect(first.indexOf("critic") < 0);
});

test("an unsafe order column is refused", () => {
  let repo = seeded();
  expect(plPage(repo, "", "", "x; DROP TABLE plume_test_agents", 10, 0) == "[]");
  expect(plCount(repo, "", "") == 3);
});

// --- projections, the mapper -----------------------------------------------------------------

test("a projection narrows a record into a DTO", () => {
  let repo = seeded();
  // JSON.parse rejects extra fields, so the projection is what makes this work.
  let json = plFindAs(repo, "id AS \"id\", agent_name AS \"agentName\"", "a1");
  let dto: AgentSummary = JSON.parse<AgentSummary>(json);
  expect(dto.id == "a1");
  expect(dto.agentName == "researcher");
});

test("a projected list narrows every row", () => {
  let repo = seeded();
  let json = plListAs(repo, "id AS \"id\", agent_name AS \"agentName\"", "", "");
  expect(json.indexOf("maxSteps") < 0);
  expect(json.indexOf("agentName") >= 0);
});

test("picking narrows a document in memory", () => {
  let full = agentJson("a1", "researcher", 5, 0.2);
  let keys: string[] = ["id", "agentName"];
  let narrowed = plPick(full, keys);
  let dto: AgentSummary = JSON.parse<AgentSummary>(narrowed);
  expect(dto.id == "a1");
  expect(dto.agentName == "researcher");
});

test("picking keeps a value containing braces intact", () => {
  let doc = "{\"id\":\"a1\",\"note\":\"{not an object}\",\"n\":2}";
  let keys: string[] = ["id", "note"];
  let out = plPick(doc, keys);
  expect(out.indexOf("{not an object}") >= 0);
  expect(out.indexOf("\"n\"") < 0);
});

test("a member reads whole values of every kind", () => {
  let doc = "{\"s\":\"text\",\"n\":42,\"f\":0.5,\"b\":true,\"o\":{\"k\":1},\"a\":[1,2]}";
  expect(plMember(doc, "s") == "\"text\"");
  expect(plMember(doc, "n") == "42");
  expect(plMember(doc, "b") == "true");
  expect(plMember(doc, "o") == "{\"k\":1}");
  expect(plMember(doc, "a") == "[1,2]");
  expect(plMember(doc, "absent") == "");
});

test("a nested key of the same name is not mistaken for a top-level one", () => {
  let doc = "{\"inner\":{\"id\":\"wrong\"},\"id\":\"right\"}";
  expect(plMember(doc, "id") == "\"right\"");
});

// --- deleting ----------------------------------------------------------------------------------

test("a record is deleted by key", () => {
  let repo = seeded();
  expect(plDelete(repo, "a1").ok);
  expect(plCount(repo, "", "") == 2);
  expect(!plExists(repo, "a1"));
});

test("records are deleted by a filter", () => {
  let repo = seeded();
  expect(plDeleteWhere(repo, "max_steps > $1", "4").ok);
  expect(plCount(repo, "", "") == 1);
});

// --- transactions -----------------------------------------------------------------------------

test("a rolled-back write leaves nothing behind", () => {
  let repo = fresh();
  expect(plBegin().ok);
  plPersist(repo, agentJson("t1", "temp", 1, 0.0));
  expect(plCount(repo, "", "") == 1);
  expect(plRollback().ok);
  expect(plCount(repo, "", "") == 0);
});

test("a committed write stays", () => {
  let repo = fresh();
  expect(plBegin().ok);
  plPersist(repo, agentJson("t2", "kept", 1, 0.0));
  expect(plCommit().ok);
  expect(plCount(repo, "", "") == 1);
});

// --- migrations --------------------------------------------------------------------------------

test("migrations apply once and are recorded", () => {
  plConnect(testConninfo());
  plExec("DROP TABLE IF EXISTS plume_migrations");
  plExec("DROP TABLE IF EXISTS plume_mig_demo");
  let names: string[] = ["V1__create", "V2__add_column"];
  let statements: string[] = [
    "CREATE TABLE plume_mig_demo (id text PRIMARY KEY)",
    "ALTER TABLE plume_mig_demo ADD COLUMN note text",
  ];
  let first = plMigrate(names, statements);
  expect(first.ok);
  expect(first.rows == 2);
  expect(plMigrationApplied("V1__create"));
  // A second run applies nothing.
  let second = plMigrate(names, statements);
  expect(second.ok);
  expect(second.rows == 0);
  plExec("DROP TABLE IF EXISTS plume_mig_demo");
});

test("a failing migration reports which one and stops", () => {
  plConnect(testConninfo());
  plExec("DROP TABLE IF EXISTS plume_migrations");
  let names: string[] = ["V1__ok", "V2__broken"];
  let statements: string[] = [
    "CREATE TABLE IF NOT EXISTS plume_mig_ok (id text)",
    "THIS IS NOT SQL",
  ];
  let r = plMigrate(names, statements);
  expect(!r.ok);
  expect(r.error.indexOf("V2__broken") >= 0);
  // The one before it stuck.
  expect(plMigrationApplied("V1__ok"));
  plExec("DROP TABLE IF EXISTS plume_mig_ok");
  plExec("DROP TABLE IF EXISTS plume_migrations");
});

test("a mismatched migration list is refused", () => {
  plConnect(testConninfo());
  let names: string[] = ["only-one"];
  let statements: string[] = ["SELECT 1", "SELECT 2"];
  let r = plMigrate(names, statements);
  expect(!r.ok);
  expect(r.error.indexOf("every migration needs a name") >= 0);
});

test("the suite leaves nothing behind", () => {
  plConnect(testConninfo());
  plDropTable(agentRepo());
  plExec("DROP TABLE IF EXISTS plume_migrations");
  plClose();
  expect(true);
});
