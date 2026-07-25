// The mapping generated from the declaration, instead of restated beside it.
//
//   cd packages/plume && lumen run zz_decorated.ts
//
import { entity } from "./entity.ts";
import { DbRepository, connectDatabase, createTable, dropTable, persist, findById } from "./plume.ts";
import { Db } from "./driver.ts";
import { sqlite } from "./sqlite.ts";

@entity("plume_decorated_agents")
class Agent {
  @id @column("id", "text")
  id: string;

  @column("agent_name", "text")
  agentName: string;

  @column("max_steps", "int")
  maxSteps: int;
}

// The row as a record, because a class instance cannot travel as JSON yet
// (spec 456). The shape is the class's, stated once more only here.
type AgentRow = {
  id: string,
  agentName: string,
  maxSteps: int,
};

let database: Db = sqlite();

function main(): void {
  let repo: DbRepository = entityAgent;
  console.log(repo.table + " " + repo.idField + "/" + repo.idColumn + " " + `${repo.fields.length}` + " " + repo.fields[1].column + ":" + repo.fields[1].sqlType);
  connectDatabase(database, "/tmp/plume_decorated.db");
  dropTable(database, repo);
  createTable(database, repo);
  let a: AgentRow = { id: "a1", agentName: "researcher", maxSteps: 12 };
  let w = persist(database, repo, JSON.stringify(a));
  console.log("persisted " + `${w.rows}` + " " + `${w.ok}`);
  console.log(findById(database, repo, "a1"));
}

main();
