import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, ok } from "../../../rest/server.ts";
import { pendingJobs } from "../../indexing.ts";

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
