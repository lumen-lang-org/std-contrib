import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, notFound, ok, queryParam } from "../../../rest/server.ts";
import { callerTags } from "../../api-core.ts";
import { holdsOwner, owningTag } from "../../owner.ts";
import { ownerUsage, usageJson } from "../../usage.ts";

@controller("/usage")
@bindings
export class UsageApi {
  db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  @get("/")
  show(req: Request): Reply {
    let tags = callerTags(req);
    let want = queryParam(req, "owner", owningTag(tags));
    if (!holdsOwner(tags, want)) { return notFound("owner " + want); }
    return ok(usageJson(ownerUsage(this.db, want)));
  }
}
