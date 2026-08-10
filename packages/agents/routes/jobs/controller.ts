import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Guarded, Reply, Request, ok } from "../../../rest/server.ts";
import { pgOnly } from "../../guards.ts";
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

  needsPg(): Guarded {
    return pgOnly(this.db, "jobs need PostgreSQL (pgvector); this runs on " + this.db.name);
  }

  @get("/")
  @Guard(needsPg)
  list(req: Request): Reply {
    return ok(JSON.stringify(pendingJobs(this.db, "").map(jobView)));
  }
}
