// A mapping derived from the class that declares the shape, instead of
// restated beside it.
//
// Needs the decorator compiler (Lumen spec 455). Everything else in this
// package works on any Lumen build; this file is the one that does not, so it
// lives under examples/ and no test suite picks it up.
//
//   cd packages/plume && lumen run examples/decorated-entity.ts

import { entity } from "../entity.ts";
import { DbRepository, connectDatabase, closeDatabase, createTable, dropTable, persist, findById, listWhere, countWhere } from "../plume.ts";
import { Db } from "../driver.ts";
import { sqlite } from "../sqlite.ts";

// The declaration is the mapping. `@column` states the column and its SQL
// type; `@id` marks the key. Nothing is guessed from a name — `agentName`
// becomes `agent_name` because the decorator was told to, not because a
// convention inferred it.
@entity("agents")
class Agent {
  @id @column("id", "text")
  id: string;

  @column("agent_name", "text")
  agentName: string;

  @column("max_steps", "int")
  maxSteps: int;

  @column("temperature", "float8")
  temperature: number;

  // No @column, so no column: a field the program keeps and the table does
  // not.
  scratch: string;
}

// The compiler ran `entity` at compile time and left its return value behind
// as a constant named for the decorator and the class:
//
//   let entityAgent: DbRepository = { table: "agents", idField: "id", ... };
//
// A record literal, not a parse — the program does no work at startup to have
// it.

// A row still crosses the boundary as a record, because a class instance
// cannot travel as JSON yet (spec 456). Once it can, this goes away and the
// class is the only statement of the shape.
type AgentRow = {
  id: string,
  agentName: string,
  maxSteps: int,
  temperature: number,
};

let database: Db = sqlite();

function agentJson(id: string, name: string, steps: int, temp: number): string {
  let r: AgentRow = { id: id, agentName: name, maxSteps: steps, temperature: temp };
  return JSON.stringify(r);
}

function main(): void {
  let agents: DbRepository = entityAgent;

  console.log("the generated mapping:");
  console.log("  table   " + agents.table);
  console.log("  key     " + agents.idField + " -> " + agents.idColumn);
  let i: int = 0;
  while (i < agents.fields.length) {
    let f = agents.fields[i];
    console.log("  field   " + f.field + " -> " + f.column + " " + f.sqlType);
    i = i + 1;
  }

  connectDatabase(database, "/tmp/decorated-entity.db");
  dropTable(database, agents);
  createTable(database, agents);

  persist(database, agents, agentJson("a1", "researcher", 5, 0.2));
  persist(database, agents, agentJson("a2", "writer", 3, 0.7));
  persist(database, agents, agentJson("a3", "critic", 8, 0.1));

  console.log("");
  console.log("count      " + `${countWhere(database, agents, "", "")}`);
  console.log("findById   " + findById(database, agents, "a1"));
  console.log("listWhere  " + listWhere(database, agents, "max_steps > " + database.placeholder, "4"));

  let back: AgentRow = JSON.parse<AgentRow>(findById(database, agents, "a2"));
  console.log("as record  " + back.agentName + " at " + `${back.temperature}`);

  dropTable(database, agents);
  closeDatabase(database);
}

main();
