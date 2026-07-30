// The same API as agents-api.ts, declared as a controller.
//
//   cd packages/rest && lumen run examples/agents-controller.ts
//
// The routes live beside the code that serves them. The compiler runs
// `controller` while compiling and leaves the table behind as a constant, so
// there is no scanning and no registration at startup.
//
// Compare `main` here with the one in agents-api.ts. There the table and the
// bindings are both written out and have to agree; here the controller is
// handed to `listen` as itself, and the two cannot disagree because they come
// from the same class.

import { controller } from "../controller.ts";
import { Request, Reply, Mount, mountedRoutes, listen, ok, created, noContent, notFound, badRequest, param, queryParam } from "../server.ts";
import { Db, DbConfig } from "../../plume/driver.ts";
import { sqlite } from "../../plume/sqlite.ts";
import { DbField, DbRepository, field, repository, connectDatabase, DbOrder } from "../../plume/plume.ts";
import { Store, store } from "../../plume/store.ts";

type AgentRow = { id: string, agentName: string, maxSteps: int };

function agentsRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
  ];
  return repository({ table: "ctl_agents", idField: "id", idColumn: "id", fields: fs });
}

// A helper, kept out of the class on purpose. `Class.invoke` dispatches over
// every method whose parameter list is exactly the one it is called with, and
// those methods have to agree on a return type — so a method taking `(Request)`
// and returning anything but `Reply` makes the class unmountable. A free
// function is never a candidate, and reads no worse.
function keyOf(req: Request): string {
  return param(req, "id");
}

// The controller. Each method answers one method and path; the class's own
// path prefixes them all, so `@get("/:id")` here is `GET /agents/:id`.
//
// A method without a route decorator is still not a route: the decorator reads
// the verbs, and nothing else becomes a path.
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
    let keys: DbOrder[] = [{ column: "agent_name" }];
    let ceiling = queryParam(req, "maxSteps", "");
    if (ceiling == "") { return ok(this.agents.listOrdered({ order: keys })); }
    return ok(this.agents.listOrdered({ where: "max_steps <= " + this.agents.db.placeholder, args: [ceiling], order: keys }));
  }

  @get("/:id")
  find(req: Request): Reply {
    let document = this.agents.findById(keyOf(req));
    if (document == "") { return notFound("agent " + keyOf(req)); }
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
    if (!this.agents.existsById(keyOf(req))) {
      return notFound("agent " + keyOf(req));
    }
    this.agents.deleteById(keyOf(req));
    return noContent();
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

  // The controller, as itself. No table is walked and no binding map is
  // written: a class instance where a `Mount` is expected goes through
  // `mount` (specs 477/478), which reads the class's name, the constant its
  // `@controller` left behind, and its methods. The `try` that answers a
  // throwing handler with a 400 is inside `mount`, once, for all of them.
  let mounts: Mount[] = [new AgentController(agents)];

  // Handler names in this table are qualified by the class the compiler named
  // — `AgentController.find`, never a prefix chosen here.
  let table = mountedRoutes(mounts);
  let i: int = 0;
  while (i < table.length) {
    console.log("route  " + table[i].method + " " + table[i].pattern + " -> " + table[i].handler);
    i = i + 1;
  }

  let problem = listen(8092, mounts);
  if (problem != "") { console.error(problem); }
}

main();
