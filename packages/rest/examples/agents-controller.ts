// The same API as agents-api.ts, declared as a controller.
//
//   cd packages/rest && lumen run examples/agents-controller.ts
//
// The routes live beside the code that serves them. The compiler runs
// `controller` while compiling and leaves the table behind as a constant, so
// there is no scanning and no registration at startup.

import { controller } from "../controller.ts";
import { Route, route, routes } from "../router.ts";
import { Request, Reply, Handler, serve, ok, created, noContent, notFound, badRequest, param, queryParam } from "../server.ts";
import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { DbField, DbRepository, field, repository, connectDatabase, asc, DbOrder } from "../../plume/plume.ts";
import { Store, store } from "../../plume/store.ts";

type AgentRow = { id: string, agentName: string, maxSteps: int };

function agentsRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
  ];
  return repository("ctl_agents", "id", "id", fs);
}

// The controller. Each method answers one method and path; the class's own
// path prefixes them all, so `@get("/:id")` here is `GET /agents/:id`.
//
// A method without a route decorator is not a route — `keyOf` below is a
// helper and stays one.
@controller("/agents")
class AgentController {
  // The repository arrives through the constructor — one thing, not a
  // connection and a mapping to thread through every call. Nothing in this
  // class reaches for a global, so a test builds one against a different
  // database and the same code runs.
  agents: Store;

  constructor(agents: Store) {
    this.agents = agents;
  }

  @get("/")
  list(req: Request): Reply {
    let keys: DbOrder[] = [asc("agent_name")];
    let ceiling = queryParam(req, "maxSteps", "");
    if (ceiling == "") { return ok(this.agents.listOrdered("", [], keys)); }
    return ok(this.agents.listOrdered("max_steps <= " + this.agents.db.placeholder, [ceiling], keys));
  }

  @get("/:id")
  find(req: Request): Reply {
    let document = this.agents.findById(this.keyOf(req));
    if (document == "") { return notFound("agent " + this.keyOf(req)); }
    return ok(document);
  }

  @post("/")
  create(req: Request): Reply {
    if (req.body == "") { return badRequest("a body is required"); }
    let written = this.agents.persist(req.body);
    if (!written.ok) { return badRequest(written.error); }
    return created(req.body);
  }

  @del("/:id")
  remove(req: Request): Reply {
    if (!this.agents.existsById(this.keyOf(req))) {
      return notFound("agent " + this.keyOf(req));
    }
    this.agents.deleteById(this.keyOf(req));
    return noContent();
  }

  keyOf(req: Request): string {
    return param(req, "id");
  }
}

// Everything the program depends on, built in one place. A different main
// builds a different one — a Postgres connection, a pool, a fake — and every
// controller below is unchanged.
function openDatabase(): Db {
  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/rest_controller.db" };
  connectDatabase(db, cfg);
  return db;
}

function seed(agents: Store): void {
  agents.dropTable();
  agents.createTable();
  let a: AgentRow = { id: "a1", agentName: "researcher", maxSteps: 5 };
  let b: AgentRow = { id: "a2", agentName: "writer", maxSteps: 3 };
  agents.persist(JSON.stringify(a));
  agents.persist(JSON.stringify(b));
}

function main(): void {
  // One place builds the dependencies. A different main opens Postgres, or a
  // pool, or a fake; the controller is unchanged.
  let agents = store(openDatabase(), agentsRepo());
  seed(agents);
  let api = new AgentController(agents);

  // `controllerAgentController` is the constant the decorator produced. The
  // bindings are written out because a decorator cannot call a method — there
  // is no reflection — and `serve` refuses to listen if one is missing.
  let bound = new Map<string, Handler>();
  bound.set("list", (req: Request) => { return api.list(req); });
  bound.set("find", (req: Request) => { return api.find(req); });
  bound.set("create", (req: Request) => { return api.create(req); });
  bound.set("remove", (req: Request) => { return api.remove(req); });

  let i: int = 0;
  while (i < controllerAgentController.length) {
    let r = controllerAgentController[i];
    console.log("route  " + r.method + " " + r.pattern + " -> " + r.handler);
    i = i + 1;
  }

  let problem = serve(8092, controllerAgentController, bound);
  if (problem != "") { console.error(problem); }
}

main();
