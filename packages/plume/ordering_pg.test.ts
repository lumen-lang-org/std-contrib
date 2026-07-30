// Ordering, against a live database.
//
//   cd packages/plume && lumen test ordering_pg.test.ts

import { Db, DbConfig } from "./driver.ts";
import { postgres } from "./postgres.ts";
import { DbField, DbOrder, DbRepository, field, repository, asc, desc, orderClause, listOrdered, pageOrdered, connectDatabase, createTable, dropTable, persist, countWhere } from "./plume.ts";

let database: Db = postgres();

type Agent = { id: string, agentName: string, maxSteps: int };

function agentsRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
  ];
  return repository({ table: "ord_agents", idField: "id", idColumn: "id", fields: fs });
}

function row(id: string, agentName: string, maxSteps: int): string {
  let a: Agent = { id: id, agentName: agentName, maxSteps: maxSteps };
  return JSON.stringify(a);
}

function seeded(): DbRepository {
  let fromEnv = process.env("PLUME_TEST_CONNINFO") ?? "";
  let cfg: DbConfig = { host: "127.0.0.1", user: "lumen", password: "lumen", database: "lumenvec" };
  if (fromEnv != "") { cfg = { options: fromEnv }; }
  connectDatabase(database, cfg);
  let repo = agentsRepo();
  dropTable(database, repo);
  createTable(database, repo);
  persist(database, repo, row("a1", "researcher", 5));
  persist(database, repo, row("a2", "writer", 3));
  persist(database, repo, row("a3", "critic", 5));
  persist(database, repo, row("a4", "editor", 8));
  return repo;
}

// The first record's id. Tolerates whitespace after the colon because MySQL's
// JSON_OBJECT emits `"id": "a1"` where the others emit `"id":"a1"` — a
// difference invisible to JSON.parse and fatal to a substring search, which is
// why the first version of this helper reported every MySQL ordering test as a
// failure of the ordering.
function firstId(document: string): string {
  let at = document.indexOf("\"id\"");
  if (at < 0) { return ""; }
  let rest = document.substring(at + 4, document.length);
  let open = rest.indexOf("\"");
  if (open < 0) { return ""; }
  let value = rest.substring(open + 1, rest.length);
  let end = value.indexOf("\"");
  if (end < 0) { return ""; }
  return value.substring(0, end);
}


// --- the clause, offline -----------------------------------------------------

test("a key list becomes an ORDER BY", () => {
  let one: DbOrder[] = [asc("max_steps")];
  expect(orderClause(one) == " ORDER BY max_steps");
  let two: DbOrder[] = [desc("max_steps"), asc("agent_name")];
  expect(orderClause(two) == " ORDER BY max_steps DESC, agent_name");
});

test("no keys is no clause, which is not the same as a refusal", () => {
  let none: DbOrder[] = [];
  expect(orderClause(none) == "");
});

test("a key that is not a plain name refuses the whole clause", () => {
  let bad: DbOrder[] = [asc("max_steps; DROP TABLE ord_agents")];
  expect(orderClause(bad) == "!");
  // And one bad key among good ones refuses too.
  let mixed: DbOrder[] = [asc("agent_name"), desc("x) --")];
  expect(orderClause(mixed) == "!");
});

// --- against the database ----------------------------------------------------

test("a list comes back in the order asked for", () => {
  let repo = seeded();
  let keys: DbOrder[] = [asc("max_steps")];
  expect(firstId(listOrdered(database, repo, { order: keys })) == "a2");
  let down: DbOrder[] = [desc("max_steps")];
  expect(firstId(listOrdered(database, repo, { order: down })) == "a4");
});

test("a second key settles a tie", () => {
  let repo = seeded();
  // a1 and a3 both have 5 steps; the name decides.
  let keys: DbOrder[] = [asc("max_steps"), asc("agent_name")];
  let json = listOrdered(database, repo, { order: keys });
  expect(json.indexOf("critic") < json.indexOf("researcher"));
  let other: DbOrder[] = [asc("max_steps"), desc("agent_name")];
  let flipped = listOrdered(database, repo, { order: other });
  expect(flipped.indexOf("researcher") < flipped.indexOf("critic"));
});

test("ordering composes with a filter and its parameters", () => {
  let repo = seeded();
  let keys: DbOrder[] = [desc("max_steps")];
  let json = listOrdered(database, repo, { where: "max_steps >= " + database.placeholder, args: ["5"], order: keys });
  expect(firstId(json) == "a4");
  expect(json.indexOf("writer") < 0);
});

test("no keys lists everything, as listWhere does", () => {
  let repo = seeded();
  let none: DbOrder[] = [];
  expect(listOrdered(database, repo, { order: none }).indexOf("researcher") >= 0);
});

test("an unsafe key refuses the read and leaves the table alone", () => {
  let repo = seeded();
  let bad: DbOrder[] = [asc("x); DROP TABLE ord_agents; --")];
  expect(listOrdered(database, repo, { order: bad }) == "[]");
  expect(countWhere(database, repo, "", []) == 4);
});

// --- pages -------------------------------------------------------------------

test("a page is ordered and bounded", () => {
  let repo = seeded();
  let keys: DbOrder[] = [asc("max_steps"), asc("id")];
  expect(firstId(pageOrdered(database, repo, { order: keys, limit: 1, offset: 0 })) == "a2");
  expect(firstId(pageOrdered(database, repo, { order: keys, limit: 1, offset: 1 })) == "a1");
  expect(firstId(pageOrdered(database, repo, { order: keys, limit: 1, offset: 2 })) == "a3");
});

test("a page with no order is refused, because it is not a page", () => {
  let repo = seeded();
  // Two requests for "the first ten" can overlap or skip rows when the
  // database is free to return them in any order. Refusing beats a paginator
  // that loses records.
  let none: DbOrder[] = [];
  expect(pageOrdered(database, repo, { order: none, limit: 2, offset: 0 }) == "[]");
});

test("the suite leaves nothing behind", () => {
  let fromEnv = process.env("PLUME_TEST_CONNINFO") ?? "";
  let cfg: DbConfig = { host: "127.0.0.1", user: "lumen", password: "lumen", database: "lumenvec" };
  if (fromEnv != "") { cfg = { options: fromEnv }; }
  connectDatabase(database, cfg);
  expect(dropTable(database, agentsRepo()).ok);
  database.close();
});
