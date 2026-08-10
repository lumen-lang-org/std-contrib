import { Db } from "../../../plume/driver.ts";
import { controller } from "../../../rest/controller.ts";
import { Reply, Request, notFound, ok, param } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { ownedRun } from "../../runlog.ts";

@controller("/runs")
export class RunApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/:id")
  find(req: Request): Reply {
    let document = ownedRun(this.db, param(req, "id"), callerTags(req));
    if (document == "") { return notFound("run " + param(req, "id")); }
    return ok(document);
  }
}
