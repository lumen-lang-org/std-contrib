import { Db } from "../../../plume/driver.ts";
import { bindings, controller } from "../../../rest/controller.ts";
import { Reply, Request, NotFound, Ok, queryParam } from "../../../rest/server.ts";
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

  @Get("/")
  show(req: Request): Reply {
    let tags = callerTags(req);
    let want = queryParam(req, "owner", owningTag(tags));
    if (!holdsOwner(tags, want)) {
      return NotFound("owner " + want);
    }
    return Ok(usageJson(ownerUsage(this.db, want)));
  }
}
