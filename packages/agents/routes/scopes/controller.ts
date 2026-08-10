import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Bound } from "../../../rest/plan.ts";
import { Guarded, Reply, ok } from "../../../rest/server.ts";
import { pgOnly } from "../../guards.ts";
import { pendingJobs } from "../../indexing.ts";
import { scopeCounts } from "../../knowledge.ts";
import { scopesJson } from "../../payload.ts";

@controller("/scopes")
@bindings
export class ScopeApi {
  db: Db;

  constructor(db: Db) { this.db = db; }

  needsPg(): Guarded {
    return pgOnly(this.db, "documents need PostgreSQL (pgvector); this runs on " + this.db.name);
  }

  @get("/")
  @Guard(needsPg)
  tree(@RequestParam("prefix", "") prefix: string): Reply {
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
