import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, notFound, ok } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { ownedRun } from "../../runlog.ts";

@controller("/runs")
@bindings
export class RunApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/:id")
  find(req: Request, @PathVariable("id") id: string): Reply {
    let document = ownedRun(this.db, id, callerTags(req));
    if (document == "") { return notFound("run " + id); }
    return ok(document);
  }
}
