// The /runs routes.

import { Db } from "../plume/driver.ts";
import { controller } from "../rest/controller.ts";
import { Reply, Request, notFound, ok, param } from "../rest/server.ts";
import { callerTags } from "./api-core.ts";
import { ownedRun } from "./runlog.ts";

// The trace side. One route, because a run is written once and read whole:
// the row and every step, one query.
@controller("/runs")
export class RunApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  // Guarded by the run row's own owner, not by a join through the thread: a
  // run may have no thread (`POST /agents/:id/run`), and this document is the
  // whole conversation — question, answer, every tool call and result. The
  // messages POST hands `runId` straight back to whoever asked, so an id alone
  // was authorisation to read any tenant's transcript.
  @get("/:id")
  find(req: Request): Reply {
    let document = ownedRun(this.db, param(req, "id"), callerTags(req));
    if (document == "") { return notFound("run " + param(req, "id")); }
    return ok(document);
  }
}
