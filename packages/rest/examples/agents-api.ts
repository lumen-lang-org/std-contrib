// A REST API over a plume-mapped table, served by rest.
//
//   cd packages/rest && lumen run examples/agents-api.ts
//   curl -s localhost:8091/agents
//   curl -s -X POST localhost:8091/agents -d '{"id":"a9","agentName":"newcomer","maxSteps":4}'
//   curl -s localhost:8091/agents/a9
//   curl -s -X DELETE -i localhost:8091/agents/a9

import { Route, route, routes } from "../router.ts";
import { Request, Reply, Handler, serve, ok, created, noContent, notFound, badRequest, param, queryParam } from "../server.ts";
import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { DbField, DbRepository, field, repository, connectDatabase, createTable, dropTable, persist, findById, listWhere, deleteById, existsById } from "../../plume/plume.ts";

type AgentRow = { id: string, agentName: string, maxSteps: int };

let database: Db = sqlite();

function agents(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
  ];
  return repository("api_agents", "id", "id", fs);
}

// The handlers. Each closes over `database` — which is the dependency
// inversion: nothing here reaches for a global, and a test hands them a
// different Db by building them against one.
function listAgents(req: Request): Reply {
  let limit = queryParam(req, "limit", "");
  if (limit == "") { return ok(listWhere(database, agents(), "", [])); }
  return ok(listWhere(database, agents(), "max_steps <= " + database.placeholder, [limit]));
}

function findAgent(req: Request): Reply {
  let doc = findById(database, agents(), param(req, "id"));
  if (doc == "") { return notFound("agent " + param(req, "id")); }
  return ok(doc);
}

function createAgent(req: Request): Reply {
  if (req.body == "") { return badRequest("a body is required"); }
  let w = persist(database, agents(), req.body);
  if (!w.ok) { return badRequest(w.error); }
  return created(req.body);
}

function deleteAgent(req: Request): Reply {
  if (!existsById(database, agents(), param(req, "id"))) {
    return notFound("agent " + param(req, "id"));
  }
  deleteById(database, agents(), param(req, "id"));
  return noContent();
}

function seed(): void {
  let cfg: DbConfig = { filename: "/tmp/rest_agents.db" };
  connectDatabase(database, cfg);
  dropTable(database, agents());
  createTable(database, agents());
  let a: AgentRow = { id: "a1", agentName: "researcher", maxSteps: 5 };
  let b: AgentRow = { id: "a2", agentName: "writer", maxSteps: 3 };
  persist(database, agents(), JSON.stringify(a));
  persist(database, agents(), JSON.stringify(b));
}

function main(): void {
  seed();
  let table: Route[] = routes([
    route("GET", "/agents", "list"),
    route("POST", "/agents", "create"),
    route("GET", "/agents/:id", "find"),
    route("DELETE", "/agents/:id", "remove"),
  ]);
  let bound = new Map<string, Handler>();
  bound.set("list", listAgents);
  bound.set("create", createAgent);
  bound.set("find", findAgent);
  bound.set("remove", deleteAgent);

  let problemText = serve(8091, table, bound);
  if (problemText != "") { console.error(problemText); }
}

main();
