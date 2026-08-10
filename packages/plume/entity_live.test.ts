// The mapping @entity generates, used against a live database.
//
// entity.test.ts checks what the decorator returns. This checks that what it
// returns is a mapping the database accepts — the two are different claims,
// and only the second is the one that matters.
//
//   sh packages/plume/build.sh
//   cd packages/plume && lumen test entity_live.test.ts

import { Description, FieldDescription, DecoratorUse, entity } from "./entity.ts";
import { Db, DbConfig } from "./driver.ts";
import { sqlite } from "./sqlite.ts";
import { DbRepository, DbField, field, repository, connectDatabase, createTable, dropTable, persist, persistMany, findById, listWhere, countWhere, deleteById, findProjected } from "./plume.ts";

let database: Db = sqlite();

type Agent = {
  id: string,
  agentName: string,
  maxSteps: int,
  temperature: number,
};

function decoratorUse(name: string, args: string[]): DecoratorUse {
  let u: DecoratorUse = { name: name, args: args };
  return u;
}

function described(name: string, declared: string, decorators: DecoratorUse[]): FieldDescription {
  let f: FieldDescription = { name: name, type: declared, decorators: decorators };
  return f;
}

// What the compiler would hand @entity for the decorated Agent class.
function agentDescription(): Description {
  let fields: FieldDescription[] = [
    described("id", "string", [decoratorUse("id", []), decoratorUse("column", ["id", "text"])]),
    described("agentName", "string", [decoratorUse("column", ["agent_name", "text"])]),
    described("maxSteps", "int", [decoratorUse("column", ["max_steps", "int"])]),
    described("temperature", "number", [decoratorUse("column", ["temperature", "float8"])]),
  ];
  let d: Description = {
    protocol: 1, kind: "class", name: "Agent", args: ["entity_test_agents"],
    file: "agent.ts", line: 1, fields: fields,
  };
  return d;
}

// The same mapping written out by hand — what the decorator replaces.
function handWritten(): DbRepository {
  let fields: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
    field("temperature", "temperature", "float8"),
  ];
  return repository({ table: "entity_test_agents", idField: "id", idColumn: "id", fields: fields });
}

function generated(): DbRepository {
  return entity(agentDescription());
}

function entityConfig(): DbConfig {
  let named: DbConfig = { filename: "/tmp/plume_entity_test.db" };
  return named;
}

function agentJson(id: string, name: string, steps: int, temp: number): string {
  let a: Agent = { id: id, agentName: name, maxSteps: steps, temperature: temp };
  return JSON.stringify(a);
}

function fresh(): DbRepository {
  connectDatabase(database, entityConfig());
  let repo = generated();
  dropTable(database, repo);
  createTable(database, repo);
  return repo;
}

test("the generated mapping equals the hand-written one, field by field", () => {
  let a = generated();
  let b = handWritten();
  expect(a.table == b.table);
  expect(a.idField == b.idField);
  expect(a.idColumn == b.idColumn);
  expect(a.fields.length == b.fields.length);
  let i: int = 0;
  while (i < a.fields.length) {
    expect(a.fields[i].field == b.fields[i].field);
    expect(a.fields[i].column == b.fields[i].column);
    expect(a.fields[i].sqlType == b.fields[i].sqlType);
    i = i + 1;
  }
});

test("a table is created from the generated mapping", () => {
  let repo = fresh();
  expect(countWhere(database, repo, "", []) == 0);
});

test("a record round-trips through the generated mapping", () => {
  let repo = fresh();
  expect(persist(database, repo, agentJson("a1", "researcher", 5, 0.2)).ok);
  let back: Agent = JSON.parse<Agent>(findById(database, repo, "a1"));
  expect(back.id == "a1");
  expect(back.agentName == "researcher");
  expect(back.maxSteps == 5);
  expect(back.temperature == 0.2);
});

test("the generated mapping renames columns, which is the point of it", () => {
  let repo = fresh();
  persist(database, repo, agentJson("a1", "researcher", 5, 0.2));
  // The column is snake, because @column said so.
  expect(findProjected(database, repo, "agent_name", "a1").indexOf("agent_name") >= 0);
  // The field is camel, because the class said so.
  expect(findById(database, repo, "a1").indexOf("agentName") >= 0);
});

test("every operation works against the generated mapping", () => {
  let repo = fresh();
  let rows: string[] = [
    agentJson("a1", "researcher", 5, 0.2),
    agentJson("a2", "writer", 3, 0.7),
    agentJson("a3", "critic", 8, 0.1),
  ];
  expect(persistMany(database, repo, "[" + rows.join(",") + "]").ok);
  expect(countWhere(database, repo, "", []) == 3);
  expect(countWhere(database, repo, "max_steps > " + database.placeholder, ["4"]) == 2);
  expect(listWhere(database, repo, "", []).indexOf("critic") >= 0);
  expect(deleteById(database, repo, "a2").ok);
  expect(countWhere(database, repo, "", []) == 2);
});

test("the suite leaves nothing behind", () => {
  connectDatabase(database, entityConfig());
  expect(dropTable(database, generated()).ok);
  database.close();
});
