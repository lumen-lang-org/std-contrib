// plume behind a threaded HTTP server, for checking that two requests in
// flight at once do not read each other's rows.
//
//   lumen run examples/concurrent_server.ts
//   sh examples/concurrent_client.sh 19311 60
//
// `http.createServer` hands each request to a worker thread, so every handler
// below runs on a thread the `Store` was not built on. The shims keep a
// connection's live result set per thread for exactly this reason; a shim that
// kept one process-wide would answer `GET /agents/:id` from whatever rows the
// last `GET /agents` happened to leave behind.
//
//   POST /agents        a document as the body
//   GET  /agents        every row, ordered
//   GET  /agents/:id    the one row, or 404
//
// The database is a file rather than ":memory:": every worker opens its own
// connection, and connections share a file where they would not share a
// private in-memory database.

import { Db, DbConfig } from "../driver.ts";
import { sqlite } from "../sqlite.ts";
import { DbField, DbRepository, DbOrder, field, repository, connectDatabase, asc } from "../plume.ts";
import { Store, store } from "../store.ts";

function agentsRepo(): DbRepository {
  let fs: DbField[] = [
    field("id", "id", "text"),
    field("agentName", "agent_name", "text"),
    field("maxSteps", "max_steps", "int"),
  ];
  return repository("conc_agents", "id", "id", fs);
}

function openDatabase(): Db {
  let db = sqlite();
  let cfg: DbConfig = { filename: "/tmp/plume_concurrency.db" };
  connectDatabase(db, cfg);
  return db;
}

function reply(status: int, body: string): HttpResponse {
  let headers = new Map<string, string>();
  headers.set("content-type", "application/json");
  return { status: status, body: body, ok: true, headers: headers };
}

// The last path segment, empty when the path is the collection itself.
function idOf(path: string): string {
  let parts = path.split("?");
  let bare = parts[0];
  let segments = bare.split("/");
  let last = segments[segments.length - 1];
  if (last == "agents") { return ""; }
  return last;
}

function main(): void {
  let agents = store(openDatabase(), agentsRepo());
  agents.dropTable();
  agents.createTable();

  http.createServer(19311, (req): HttpResponse => {
    let id = idOf(req.path);
    if (req.method == "POST") {
      let written = agents.persist(req.body);
      if (!written.ok) { return reply(400, "{\"error\":\"" + written.error + "\"}"); }
      return reply(201, req.body);
    }
    if (id == "") {
      let keys: DbOrder[] = [asc("id")];
      let empty: string[] = [];
      return reply(200, agents.listOrdered("", empty, keys));
    }
    let document = agents.findById(id);
    if (document == "") { return reply(404, "{\"error\":\"no agent " + id + "\"}"); }
    return reply(200, document);
  });
}

main();
