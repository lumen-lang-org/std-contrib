// A mapping bound to a connection, against a live database.
//
//   cd packages/plume && lumen test store.test.ts

import { Db, DbConfig } from "./driver.ts";
import { sqlite } from "./sqlite.ts";
import { Store, store } from "./store.ts";
import { DbField, DbOrder, DbRepository, field, repository, asc, connectDatabase } from "./plume.ts";

let database: Db = sqlite();

type Agent = { id: string, agentName: string, maxSteps: int };

function agentsMapping(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
  ];
  return repository({ table: "store_agents", idField: "id", idColumn: "id", fields: fs });
}

function agentJson(id: string, agentName: string, maxSteps: int): string {
  let a: Agent = { id: id, agentName: agentName, maxSteps: maxSteps };
  return JSON.stringify(a);
}

function seeded(): Store {
  let cfg: DbConfig = { filename: "/tmp/plume_store_test.db" };
  connectDatabase(database, cfg);
  let agents = store(database, agentsMapping());
  agents.dropTable();
  agents.createTable();
  agents.persist(agentJson("a1", "researcher", 5));
  agents.persist(agentJson("a2", "writer", 3));
  return agents;
}

test("a store carries what it was built from", () => {
  let agents = store(database, agentsMapping());
  expect(agents.mapping.table == "store_agents");
  // So anything the store does not cover is one plume call away.
  expect(agents.db.name == "sqlite");
});

test("reading through a store needs neither the db nor the mapping", () => {
  let agents = seeded();
  let back: Agent = JSON.parse<Agent>(agents.findById("a1"));
  expect(back.agentName == "researcher");
  expect(agents.count() == 2);
  expect(agents.existsById("a2"));
  expect(!agents.existsById("a9"));
});

test("list is listWhere with nothing to filter on", () => {
  let agents = seeded();
  expect(agents.list().indexOf("researcher") >= 0);
  expect(agents.list() == agents.listWhere("", []));
});

test("a filter still takes its parameters", () => {
  let agents = seeded();
  expect(agents.countWhere("max_steps > " + database.placeholder, ["4"]) == 1);
  expect(agents.listWhere("agent_name = " + database.placeholder, ["writer"]).indexOf("a2") >= 0);
});

test("ordering comes through too", () => {
  let agents = seeded();
  let keys: DbOrder[] = [asc("max_steps")];
  expect(agents.listOrdered({ order: keys }).indexOf("writer") < agents.listOrdered({ order: keys }).indexOf("researcher"));
  expect(agents.pageOrdered({ order: keys, limit: 1, offset: 0 }).indexOf("writer") >= 0);
});

test("writing through a store", () => {
  let agents = seeded();
  expect(agents.persist(agentJson("a3", "critic", 8)).ok);
  expect(agents.count() == 3);
  expect(agents.deleteById("a3").ok);
  expect(agents.count() == 2);
  expect(agents.deleteWhere("max_steps < " + database.placeholder, ["4"]).ok);
  expect(agents.count() == 1);
});

test("two stores over one connection stay separate", () => {
  let agents = seeded();
  let others = store(database, repository({ table: "store_others", idField: "id", idColumn: "id", fields: agentsMapping().fields }));
  others.dropTable();
  others.createTable();
  others.persist(agentJson("b1", "other", 1));
  // Each reads its own table.
  expect(agents.count() == 2);
  expect(others.count() == 1);
  expect(others.findById("a1") == "");
  others.dropTable();
});

test("the schema helpers are the same functions with the mapping supplied", () => {
  let agents = store(database, agentsMapping());
  expect(agents.createTableSql().indexOf("CREATE TABLE IF NOT EXISTS store_agents") >= 0);
  // No relations declared, so no keys to generate.
  expect(agents.foreignKeys().length == 0);
});

test("the suite leaves nothing behind", () => {
  let agents = seeded();
  expect(agents.dropTable().ok);
  database.close();
});
