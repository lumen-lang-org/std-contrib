import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, badRequest, ok } from "../../../rest/server.ts";
import { pendingJobs } from "../../indexing.ts";
import { scopeCounts } from "../../knowledge.ts";
import { scopesJson } from "../../payload.ts";

@controller("/scopes")
export class ScopeApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  @get("/")
  tree(@RequestParam("prefix", "") prefix: string): Reply {
    if (this.db.name != "postgres") {
      return badRequest("documents need PostgreSQL (pgvector); this runs on " + this.db.name);
    }
    let waiting = pendingJobs(this.db, "");
    let pending: string[] = [];
    let w: int = 0;
    while (w < waiting.length) {
      pending.push(waiting[w].scope);
      w = w + 1;
    }
    return ok(scopesJson(scopeCounts(this.db, prefix, pending)));
  }
}
