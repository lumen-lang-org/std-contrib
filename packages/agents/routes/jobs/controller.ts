import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, ok } from "../../../rest/server.ts";
import { IndexJobRow, pendingJobs } from "../../indexing.ts";
import { JobView } from "./types.ts";

function jobView(r: IndexJobRow): JobView {
  return {
    id: r.id,
    source: r.source,
    scope: r.scope,
    status: r.status,
    chunks: r.chunks,
    error: r.error,
    createdAt: r.createdAt,
  };
}

@controller("/jobs")
export class JobApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  list(req: Request): Reply {
    if (this.db.name != "postgres") { return ok("[]"); }
    return ok(JSON.stringify(pendingJobs(this.db, "").map(jobView)));
  }
}
