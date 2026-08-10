import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, ok } from "../../../rest/server.ts";
import { pendingJobs } from "../../indexing.ts";

// The /jobs routes.

// The folder tree, as the documents describe it.
//
// Derived, not stored: there is no folder table to keep in step with the rows,
// so a folder exists exactly as long as something is in it.
// What the indexer is doing, across every folder. The console polls this
// while anything is in flight.
@controller("/jobs")
export class JobApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    if (this.db.name != "postgres") { return ok("[]"); }
    let rows = pendingJobs(this.db, "");
    let out = "[";
    let i: int = 0;
    while (i < rows.length) {
      if (i > 0) { out = out + ","; }
      out = out + "{\"id\":" + JSON.stringify(rows[i].id)
        + ",\"source\":" + JSON.stringify(rows[i].source)
        + ",\"scope\":" + JSON.stringify(rows[i].scope)
        + ",\"status\":" + JSON.stringify(rows[i].status)
        + ",\"chunks\":" + `${rows[i].chunks}`
        + ",\"error\":" + JSON.stringify(rows[i].error)
        + ",\"createdAt\":" + JSON.stringify(rows[i].createdAt) + "}";
      i = i + 1;
    }
    return ok(out + "]");
  }
}
